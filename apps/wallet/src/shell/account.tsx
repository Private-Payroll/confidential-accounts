import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { GLYPH, Icon } from '../kit/icon.js';
import { shortPayee } from 'midnight-identity';
import type { Identity, Secret } from 'midnight-identity';
import { NETWORK } from '../config.js';
import { ownedAddressFor } from '../accounts/owned-address.js';
import type { OwnedAddress } from '../accounts/owned-address.js';
import { Mark } from './mark.js';
import { SidebarMenuButton, useSidebar } from '../kit/sidebar.js';
import { AddressEnds, WalletSwitcher, endsOf } from './switcher.js';
import { useWallets } from './wallets.js';

/**
 * THE ACCOUNT CHIP — chrome on every place, and the switcher behind it.
 *
 * WHICH WALLET IS OPEN IS ALREADY DECIDED, AND NOT BY THIS FILE. The rule
 * `screens/home.tsx` has always stated still stands: the selection lives in
 * STORAGE, every switch writes `lastUsed`, and both surfaces read that record.
 * So this chip is a READER — never a second source of truth for a fact the rule
 * says two surfaces must never disagree about.
 *
 * §3 RETIRED THE WORKAROUND THAT MADE THAT WORK. The old shell had no way to hear about
 * a switch made on the home screen's own bar — `storage.ts` is frozen and emits
 * no change event — so the chip re-read the record after ANY CLICK ANYWHERE IN
 * THE DOCUMENT. `shell/wallets.ts` is the change event instead: one
 * subscription, notified by the two writers, read by the chip and the screen
 * alike.
 *
 * THE SWITCHER MOVED OUT OF THIS FILE. It was the only dialog in the
 * repository and it reached past the kit into Radix directly; the kit now has
 * `dialog`, and the design asks for *"one switcher, two doors"* because
 * Home needs the same list beside its balance. The list, the addresses and the
 * refusal are in `shell/switcher.tsx`; what is left here is the CHIP — the face
 * and its accessible name — handed to that switcher as its trigger.
 *
 * `AddressEnds` and `endsOf` moved with it, and are re-exported nowhere: this
 * file imports them like any other caller, so there is one definition of *how
 * an address fragment is drawn* rather than two that could drift.
 */

/**
 * THE FACE OF THE CHIP — mark, name, address ends — with no opinion about
 * whether it can be pressed.
 *
 * IT IS ONE FUNCTION BECAUSE THERE ARE TWO CHIPS. A place gets the tappable
 * one; a flow gets a static one (below). If those two ever drew the account
 * differently, the wallet would be naming an account one way on the screen a
 * person switches from and another way inside the ceremony they switched into —
 * which is that failure with the disagreement moved into the chrome, and
 * exactly what `shell.test.tsx` claim 2 exists to catch.
 */
function ChipFace({ owned, wallet }: {
  readonly owned: OwnedAddress;
  /** The name of the WHOLE wallet, or null. Above the account's own
   * name because it is the larger fact: which wallet, then which account in
   * it. A wallet with no name draws exactly what this chip drew before. */
  readonly wallet: string | null;
}): ReactNode {
  return (
    <>
      <Mark address={owned.address.bech32} account={owned.account} size={24} />
      <span className="min-w-0">
        {wallet !== null && (
          <span className="block truncate text-xs text-faint" data-whole-wallet="">
            {wallet}
          </span>
        )}
        {/* Was `text-[0.82rem]`. `text-sm` is 0.875rem: the nearest
          * step up, and the chip's name is the line that may truncate, so a
          * slightly larger one costs nothing the layout was protecting. */}
        <span className="block truncate text-sm font-semibold text-ink">
          {owned.name}
        </span>
        {/* The address is NOT allowed to truncate. A name is a label and a
          * clipped one is still recognisable; a clipped address fragment loses
          * the end, which is the half worth comparing. So the name
          * gives way first. */}
        <span className="block">
          <AddressEnds short={shortPayee(owned.address)} />
        </span>
      </span>
    </>
  );
}

const CHIP_BOX = [
  'flex min-h-touch min-w-0 items-center gap-2.5 rounded-card border border-line',
  'bg-raised px-2.5 py-1.5 text-left font-normal',
].join(' ');

/**
 * THE CHIP DURING A FLOW — SHOWN, NOT TAPPABLE. The design,
 * correcting an earlier reading of the change's "flows get no navigation" as "flows get
 * no chip".
 *
 * **THE CHIP IS IDENTITY, NOT NAVIGATION**, and the two are not the same thing.
 * Trouble is what happens when a ceremony does not name the account it is about —
 * *"the secured record names no account, so it outlives the account it
 * describes"* — so somebody cutting an account into pieces has to be able to
 * see WHICH account, on the screen, while they do it.
 *
 * NOT TAPPABLE, and that half is a security property rather than a tidiness
 * one: switching wallets in the middle of a ceremony is an ordering fault — a
 * flow that began about one account finishing about another. So this is a
 * `<div>` with no handler, no dialog, and no place in the tab order. A disabled
 * `<button>` would be wrong twice: it would still be a control, and it would
 * invite the press it exists to refuse.
 */
export function FlowAccountChip({ identity, secret }: {
  readonly identity: Identity;
  readonly secret: Secret;
}): ReactNode {
  const { names, account, wallet } = useWallets(secret);
  const owned = useMemo(
    () => ownedAddressFor(identity, account, names, NETWORK),
    [identity, account, names],
  );
  return (
    <div
      data-account={account}
      data-tappable="false"
      /* Named for a screen reader, which otherwise meets a mark, a name and
       * eight characters of address with nothing saying what they are. */
      aria-label={`This is about ${owned.owner}, ${endsOf(shortPayee(owned.address))}`
        + (wallet !== null ? `, in ${wallet}` : '')}
      className={CHIP_BOX}
    >
      <ChipFace owned={owned} wallet={wallet} />
    </div>
  );
}

/**
 * THE CHIP, AND THE SWITCHER BEHIND IT — in two places, because there are two
 * layouts and only one of them has a sidebar.
 *
 * `variant="sidebar"` is the design's *"the wallet switcher moves into
 * the footer, where `sidebar-07` puts its user menu"*. It is drawn with the
 * block's own `SidebarMenuButton size="lg"`, which is exactly what
 * `sidebar-07`'s `NavUser` uses, so it collapses to the mark alone by the same
 * `group-data-[collapsible=icon]` rule as every other row.
 *
 * `variant="bar"` is the phone, where there is no sidebar to put it in and the
 * place header carries it — the same split the theme and lock controls have had
 * from the start. Both are the same component reading the same record, because two
 * surfaces naming the wallet differently is a disagreement moved into the chrome.
 */
export function AccountChip({ identity, secret, variant }: {
  readonly identity: Identity;
  readonly secret: Secret;
  readonly variant: 'bar' | 'sidebar';
}): ReactNode {
  const { names, account, wallet } = useWallets(secret);
  const { state } = useSidebar();
  const collapsed = variant === 'sidebar' && state === 'collapsed';
  const owned = useMemo(
    () => ownedAddressFor(identity, account, names, NETWORK),
    [identity, account, names],
  );

  const label = `${owned.owner}, ${endsOf(shortPayee(owned.address))}`
    + (wallet !== null ? `, in ${wallet}` : '')
    + ' — change wallet';

  const trigger = variant === 'sidebar'
    ? (
      <SidebarMenuButton
        size="lg"
        data-account={account}
        aria-label={label}
        className="border border-line bg-bg data-[state=open]:bg-sunken"
      >
        <Mark address={owned.address.bech32} account={owned.account} size={28} />
        {!collapsed && (
          <>
            <span className="grid min-w-0 flex-1 text-left">
              {wallet !== null && (
                <span className="truncate text-xs text-faint" data-whole-wallet="">
                  {wallet}
                </span>
              )}
              <span className="truncate text-sm font-semibold text-ink">{owned.name}</span>
              <span className="truncate">
                <AddressEnds short={shortPayee(owned.address)} />
              </span>
            </span>
            <Icon glyph={GLYPH.switcher} className="ml-auto size-3.5 text-faint" />
          </>
        )}
      </SidebarMenuButton>
    )
    : (
      <button
        type="button"
        data-account={account}
        aria-label={label}
        className={[
          CHIP_BOX,
          'flex-1',
          'transition-colors duration-(--motion-quick)',
          'hover:border-line-strong focus-visible:border-line-strong',
        ].join(' ')}
      >
        <ChipFace owned={owned} wallet={wallet} />
        <Icon glyph={GLYPH.switcher} className="size-3.5 text-faint" />
      </button>
    );

  return (
    <WalletSwitcher identity={identity} secret={secret}>
      {trigger}
    </WalletSwitcher>
  );
}
