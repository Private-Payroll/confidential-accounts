import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Identity, Secret } from 'midnight-identity';
import { NETWORK } from '../config.js';
import { ownedAddressFor } from '../accounts/owned-address.js';
import { hrefOf } from '../routes.js';
import { arrivalOf, loadSecuredSetup } from '../accounts/storage.js';
import { displayNameOf } from '../accounts/subwallets.js';
import { renameWallet, useWallets } from '../shell/wallets.js';
import { InboxCard } from '../components/inbox-card.js';
import { StatusAlert } from '../components/status.js';
import { HeroCard } from './home-hero.js';
import { QuickActions } from './home-shortcuts.js';
import { RecentActivity, AllWalletsCard, PendingSendsCard } from './home-wallet-cards.js';
import {
  UnsecuredNotice,
  RecoveredUnknownCard,
  PairedUnknownCard,
  SecuredCard,
  ThisDeviceCard,
  SetUp
} from './home-securing.js';

/**
 * HOME — the screen that decides whether a tester continues.
 *
 * THIS SCREEN REBUILDS ITS CONTENTS AND CHANGES NOTHING IT KNOWS. The rules this file
 * has always stated still hold and are still the reason it is shaped this way:
 *
 *   THE SECURING STATE IS THE FIRST THING SAID. `loadSecuredSetup` refuses a
 *   record cut from a different secret, and the subwallet names and
 *   last-used slot are held to the same rule.
 *
 *   THE SELECTION LIVES IN STORAGE, NOT IN A PROVIDER. Every switch writes
 *   `lastUsed`, so navigating away and back — or locking and unlocking — lands
 *   on the wallet that was open. `shell/wallets.ts` is the change event
 *   `storage.ts` cannot emit: this screen and the chip subscribe to the same
 *   record and are notified by the same write. No second copy.
 *
 * WHAT THIS SCREEN SHOWS, and the order it reads in:
 *
 *   THE BACKUP ALERT SITS ABOVE THE BALANCE and disappears entirely once the
 *   account is secured, so it never permanently pushes the balance down. It is
 *   the kit's amber `Alert` — what is at risk, not what is undone — carrying
 * §7.7's sentence unchanged.
 *
 *   THE HERO IS THE UNSHIELDED NIGHT BALANCE at the display size the kit added.
 *
 *   **THE HERO AND THE TOKEN LIST ARE ONE OBJECT, and that is a judgement this
 *   file makes rather than a reading of the instruction.** The design names
 *   them as two sections; built as two they print the same balance twice on one
 *   screen, and a wallet that says 5,000 tNIGHT in two places is a wallet whose
 *   two numbers can disagree. So the token list IS the three lines — unshielded
 *   NIGHT, private, DUST — with the first of them promoted to display size and
 *   the other two quiet beneath it. `TOKEN_LINES` (in `home-hero.tsx`) is an array, so a fourth
 *   token is one entry rather than a redesign, which is what *"build the list
 *   so more rows slot in"* is protecting.
 *
 *   NOTHING LEAVES THIS BROWSER UNTIL THE BUTTON IS PRESSED, and the hero did
 *   NOT change that. Asking the indexer tells its operator this wallet's
 *   address, so the asking is an act a person performs — `SECURITY.md`'s
 *   promise that opening the wallet page calls nobody, and `balance.test.tsx`'s
 *   first claim.
 *
 *   THE ADDRESS MOVED INTO RECEIVE. It is a popup because it moves nothing and
 *   goes through no approval path. **SEND DOES NOT**: send carries the approval
 *   surface, and *one surface approves anything that moves money* is the rule
 *   the agent and the payroll integration both depend on — so Send is a LINK to
 *   a screen and will never be a modal.
 *
 *   EVERY VISIBLE THING IS THE SHARED KIT'S, or the wallet's rows and notices
 *   built from it (`components/`). No component is defined in
 *   this file that a second screen could want; the switcher is the shell's own
 *   and is reached through `shell/switcher.tsx` rather than reimplemented,
 *   which is the rule *"one switcher, two doors"*.
 */
export function Home({
  identity,
  secret,
  justRecovered = false
}: {
  readonly identity: Identity;
  readonly secret: Secret;
  /**
   * True when this account arrived by a completed recovery in this very
   * session. §7.15: the landing writes the secured record itself, so
   * normally `loadSecuredSetup` finds one — but if that write could not stand
   * behind the evidence, the person who JUST proved their pieces work must not
   * be greeted with "the money is gone". Three states, not two.
   */
  readonly justRecovered?: boolean;
}): ReactNode {
  const { names, account } = useWallets(secret);

  /* THE SHEET IS A SNAPSHOT — the answer (a), the honest half. The
   * securing flow prints a sheet that can carry these names, but a name given
   * or changed after it was printed is not on it, and a person who believes the
   * paper carries their names would be wrong. So a rename on a SECURED account
   * says so, and points at the reprint. */
  const [sheetStale, setSheetStale] = useState(false);
  /* Bumped whenever a sync establishes a number, so the all-wallets card
   * re-reads its checkpoint summaries without owning the sync itself. */
  const [checkpointsChanged, setCheckpointsChanged] = useState(0);

  const rename = (name: string): void => {
    renameWallet(secret, account, name);
    if (loadSecuredSetup(secret) !== null) setSheetStale(true);
  };

  const name = displayNameOf(account, names);
  /* The ONE door from a slot to a renderable address. The owner travels
   * inside the value, so nothing below can render the address without it.
   * `names` is deliberately a dependency: a rename re-derives the owner
   * everywhere at once. */
  const owned = useMemo(() => ownedAddressFor(identity, account, names, NETWORK), [identity, account, names]);
  const secured = loadSecuredSetup(secret);
  /* The DURABLE half of §7.15's third state: an account that arrived by pairing
   * carries that fact in storage, fingerprint-checked, so a reload does not
   * greet its owner with "your account exists only in this browser" — pairing
   * just demonstrated the opposite. Pairing proves the OTHER machine had the
   * account and nothing about pieces, so this is never a tick. */
  const arrived = secured === null ? arrivalOf(secret) : null;
  const unknown = !secured && (justRecovered || arrived !== null);

  return (
    <div className="flex flex-col gap-4">
      {/* The switch, said out loud for a screen reader — the visual half of
       * "unmistakable" is the hero above changing name and colour. */}
      <div role="status" aria-live="polite" className="visually-hidden">
        {`Now showing ${name}`}
      </div>

      {sheetStale && (
        <StatusAlert tone="warning" title="Your printed sheet of pieces is now out of date">
          It was made before this name.{' '}
          <a className="text-primary underline-offset-4 hover:underline" href={hrefOf('secure')}>
            Reprint it from the securing screen.
          </a>{' '}
          The pieces themselves are untouched; only the names on the paper age.
        </StatusAlert>
      )}

      {/* ABOVE THE BALANCE, AND GONE THE MOMENT IT IS UNTRUE. */}
      {!secured && !unknown && <UnsecuredNotice />}

      {/* THE ACTIONS COME OUT OF THEIR CARD AND SIT ABOVE THE
       * MONEY. They were a card titled *"Do something"* below the
       * balance; they are the reason a person opened the wallet. The SET and
       * the ORDER are unchanged and so is every rule on them — this moves a
       * row and changes no action.
       *
       * IT IS STILL BELOW THE AMBER ALERT. The order here
       * was *"the one thing that can cost everything sits first"*, and the
       * alert is gone the moment the account is secured, so nothing is
       * permanently above the actions either. */}
      <QuickActions owned={owned} />

      <HeroCard
        key={account}
        identity={identity}
        secret={secret}
        owned={owned}
        names={names}
        onRename={rename}
        onEstablished={() => setCheckpointsChanged((n) => n + 1)}
      />

      {/* THE CARRIED QUESTION — under the hero, when there is one, and nothing at all when
       * there is not. This change PLACES the card; it does not rebuild it. */}
      <PendingSendsCard secret={secret} />

      {/* WHAT IS WAITING FOR YOU SOMEWHERE ELSE.
       * BELOW THE MONEY AND ABOVE THE RECORD-KEEPING, because it is neither:
       * it is a report about somewhere else, and it approves nothing
       * (`../components/inbox-card.tsx`). It renders in every state including the one
       * this build ships in — there is no inbox host, and *nothing is being
       * asked* is a sentence a person is owed rather than an empty space.
       *
       * IT TAKES NO PROPS. The poller's lifetime is the unlocked phase and is
       * owned by `app.tsx`; this card subscribes to what it finds
       * (`../accounts/inbox-live.ts`), the way the chip and this screen both subscribe
       * to `shell/wallets.ts` rather than being handed a copy. */}
      <InboxCard />

      <RecentActivity />

      {/* The securing state in full — the tick and its pieces, or the two
       * honest "this browser cannot tell" cards. The amber alert above is the
       * only thing that appears when nothing is on record. */}
      {secured ? (
        <SecuredCard setup={secured} />
      ) : justRecovered ? (
        <RecoveredUnknownCard />
      ) : arrived !== null ? (
        <PairedUnknownCard at={arrived.at} />
      ) : null}

      <ThisDeviceCard secret={secret} />

      <SetUp state={secured ? 'secured' : unknown ? 'unknown' : 'unsecured'} />

      <AllWalletsCard identity={identity} secret={secret} names={names} changed={checkpointsChanged} />
    </div>
  );
}
