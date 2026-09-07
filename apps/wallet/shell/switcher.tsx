import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { shortPayee } from 'midnight-identity';
import type { Identity, Secret } from 'midnight-identity';
import { NETWORK } from '../config.js';
import { ownedAddressFor } from '../owned-address.js';
import type { OwnedAddress } from '../owned-address.js';
import { splitShortAddress } from '../short-address.js';
import {
  MAIN_ACCOUNT, OFFERED_UP_FRONT, SUBWALLET_ACCOUNTS, WALLET_ACCOUNTS,
} from '../subwallets.js';
import { GLYPH, Icon } from '../kit/icon.js';
import { Button } from '../kit/button.js';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '../kit/dialog.js';
import { Mark } from './mark.js';
import { switchWallet, useWallets } from './wallets.js';
import { WalletBalanceCell, rowFor, useWalletBalances } from './wallet-balances.js';

/**
 * THE WALLET SWITCHER — ONE SWITCHER, TWO DOORS.
 *
 * THE RULE: *"The switch opens the same switcher the sidebar footer
 * uses. One switcher, two doors — not a second implementation."* This file is
 * that switcher. The sidebar's account chip opens it; so does the control
 * beside the balance on Home. Neither owns it.
 *
 * WHY IT IS ITS OWN FILE RATHER THAN AN EXPORT FROM `account.tsx`. The chip
 * calls `useSidebar()`, which throws outside a `SidebarProvider` — so a screen
 * reusing the chip would have to mount the shell's provider to show a button.
 * Splitting the DIALOG from the CHIP is what makes the switcher reachable from
 * a place's own content without dragging the frame in with it.
 *
 * THE TRIGGER IS THE CALLER'S. Everything inside — the list, the addresses, the
 * refusal, the copy — is here, once. A second implementation of this list is
 * A disagreement moved into the chrome: two surfaces naming the same wallet,
 * free to disagree.
 *
 * `Account 1 never appears`: the list is built from `WALLET_ACCOUNTS`,
 * which cannot contain it; `switchWallet` refuses it a second time and
 * `saveLastUsedWallet` a third.
 */

/**
 * THE FRAGMENT — the two ends, and not the run in front of them.
 *
 * `short-address.ts` splits a shortened address into the network prefix every
 * address on the chain shares and the two ends that are the only parts worth
 * comparing. A row has one line, and a prefix identical on every address
 * in existence is the half that can be dropped without losing anything: the
 * network is named by the chip beside this one, and the whole address appears
 * on the screen that approves a payment.
 */
export function AddressEnds({ short }: { readonly short: string }): ReactNode {
  const parts = splitShortAddress(short);
  return (
    <span className="font-mono text-xs whitespace-nowrap text-muted">
      {parts.head}
      {parts.tail !== null && <><span className="text-faint">…</span>{parts.tail}</>}
    </span>
  );
}

/** The same fragment as a sentence, for a control's accessible name. */
export const endsOf = (short: string): string => {
  const parts = splitShortAddress(short);
  return parts.tail === null ? parts.head : `${parts.head}…${parts.tail}`;
};

function WalletRow({ owned, current, balance, onChoose }: {
  readonly owned: OwnedAddress;
  readonly current: boolean;
  /** What is known about this slot's money, or nothing at all. */
  readonly balance?: ReactNode;
  readonly onChoose: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      data-account={owned.account}
      /* The hook the tests read, and it is an ATTRIBUTE rather than a
       * class on purpose: `data-wallet-row` says *this is a row of the
       * switcher* and survives any restyling, where the old `.wallet-row`
       * carried an `app.css` rule as well and could not be moved without
       * moving the look with it.
       *
       * `data-wallet-balance-row` arrives beside it, carrying the claim
       * that came here from Home's every-wallet card: *this is one of the
       * eleven, and what it says about its money is on it*. Two names on one
       * row because there are two claims, and a test that wants one of them
       * should not have to know about the other. */
      data-wallet-balance-row=""
      data-wallet-row=""
      aria-current={current ? 'true' : undefined}
      onClick={onChoose}
      className={[
        'flex min-h-touch w-full items-center gap-3 overflow-hidden rounded-tight border px-3 py-2 text-left',
        'bg-transparent font-normal',
        'transition-colors duration-(--motion-quick)',
        current
          ? 'border-line-strong bg-sunken'
          : 'border-transparent hover:border-line hover:bg-sunken focus-visible:border-line',
      ].join(' ')}
    >
      <Mark address={owned.address.bech32} account={owned.account} size={30} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink">{owned.name}</span>
        <span className="block truncate">
          <AddressEnds short={shortPayee(owned.address)} />
        </span>
      </span>
      {/* THE COLUMN IS FIXED, AND THAT IS THE WHOLE OF THE FIX.
        *
        * It was `shrink-0` with no width, and the balance line inside it was
        * `whitespace-nowrap` (`shell/wallet-balances.tsx`): an unbreakable
        * forty-character run that the row's minimum width could not go below.
        * `DialogContent` is a `grid` with `overflow-y-auto` and no `overflow-x`
        * (`kit/dialog.tsx:200`), so its implicit column sized itself to that
        * minimum and the browser resolved the other axis to `auto` — which is
        * why the panel grew a horizontal scrollbar SECONDS after opening, when
        * the stored checkpoints answered and `never checked` became a number
        * with a moment beside it. The nowrap is gone; this width is what stops
        * it coming back through anything else printed here.
        *
        * A WIDTH RATHER THAN A MAX-WIDTH, because the requirement is that the
        * dialog does not JUMP. A column sized to its content changes size when
        * the content arrives and drags every other column with it; this one is
        * the same width before the sweep answers and after it, so the space is
        * reserved rather than found.
        *
        * 7rem below the layout switch and 8rem above it. Above it the panel is
        * a fixed 26rem and can spare the room; below it the panel is as wide as
        * the phone, and the address beside it is seventeen monospaced
        * characters that must not be shortened to buy space here. */}
      <span className="w-28 shrink-0 text-right wide:w-32">
        <span className="block truncate text-xs text-faint">{owned.slot}</span>
        {balance !== undefined && <span className="block">{balance}</span>}
      </span>
      {current
        ? <Icon glyph={GLYPH.chosen} className="size-4 shrink-0 text-accent" />
        : <span className="size-4 shrink-0" aria-hidden="true" />}
    </button>
  );
}

/**
 * The switcher's list. It is built and its addresses derived only when the
 * dialog opens — eleven derivations is a real cost and a closed dialog must not
 * pay it on every render of every place.
 *
 * =====================================================================
 * THE BALANCES ARE HERE NOW, AND THE OLD RULE IS WHY THEY CAN BE.
 * =====================================================================
 *
 * This comment used to say *"there are no balances here, deliberately"*, and
 * gave the reason: **a picker showing a stored number without the sentences
 * that make it honest would be a balance with no time beside it, which is the
 * the same shape.** That reason has not weakened, and it is not what
 * changed. The design moves the eleven-wallet sweep here, *"where a person
 * has asked to see all of them"* — so the condition the old rule set is the
 * one this list now meets: **the sentences came with the numbers.**
 * `WalletBalanceCell` is the one that was on Home, unchanged — *never checked*
 * in warning words, *couldn't check — not a zero*, and a number that always
 * carries the moment it was true of and the KIND of money it is.
 *
 * NOTHING SYNCS BECAUSE THIS OPENED. The rows read stored checkpoints, which
 * asks nobody anything; the sweep is a press, and the press is what the
 * indexer learns (`balance.ts:30-46`). Eleven slots is eleven asks, so it is
 * one at a time and it is never automatic.
 *
 * PRESSING THE SWEEP REVEALS EVERY SLOT. A control that says *check all
 * eleven* while six are on screen would be checking things a person cannot
 * see; `Show every slot` is still there for somebody who only wants to look.
 *
 * THE CHECKPOINTS ARE READ HERE AND NOT IN `WalletSwitcher`, DELIBERATELY.
 * Radix mounts a closed dialog's content not at all, so this component exists
 * only while somebody is looking at it — and reading eleven checkpoints means
 * deriving eleven coin public keys and opening eleven sealed records. Three
 * switchers are mounted on Home at once (the money card's control, this
 * card's chevron, and the sidebar's chip); doing that work in the trigger's
 * component would be thirty-three of each, on every load, for a dialog nobody
 * has opened. `showAll` re-renders this component without unmounting it, so
 * a sweep in flight is unaffected.
 */
function WalletList({ identity, names, account, onSwitch }: {
  readonly identity: Identity;
  readonly names: Readonly<Record<string, string>>;
  readonly account: number;
  readonly onSwitch: (next: number) => void;
}): ReactNode {
  const { rows, sweeping, sweep } = useWalletBalances(identity);
  const [showAll, setShowAll] = useState(
    () => !SUBWALLET_ACCOUNTS.slice(0, OFFERED_UP_FRONT).concat(MAIN_ACCOUNT).includes(account),
  );
  const offered = showAll
    ? WALLET_ACCOUNTS
    : [MAIN_ACCOUNT, ...SUBWALLET_ACCOUNTS.slice(0, OFFERED_UP_FRONT)];
  const owned = useMemo(
    () => offered.map((a) => ownedAddressFor(identity, a, names, NETWORK)),
    /* `showAll` stands in for `offered`, which is derived from it — listing the
     * array itself would rebuild eleven addresses on every render. */
    [identity, names, showAll],
  );
  return (
    /* `min-w-0` — the list is the grid item inside `DialogContent`, and a grid
     * item's automatic minimum size is its content's. Without this, one wide
     * row raises the floor of the whole panel however the row itself is built. */
    <div className="flex min-w-0 flex-col gap-1">
      {owned.map((one) => (
        <WalletRow
          key={one.account}
          owned={one}
          current={one.account === account}
          balance={<WalletBalanceCell row={rowFor(rows, one.account)} />}
          onChoose={() => onSwitch(one.account)}
        />
      ))}
      {!showAll && (
        <button
          type="button"
          className={[
            'min-h-touch rounded-tight border-0 bg-transparent px-3 py-2 text-left',
            'text-sm font-normal text-accent hover:underline',
          ].join(' ')}
          onClick={() => setShowAll(true)}
        >
          Show every slot
        </button>
      )}

      {/* THE SWEEP, AND ITS OWN PARAGRAPH — both moved here from Home's card
        * together. The words are the ones that were on
        * that card: they say what the sweep costs, that nothing happens
        * unasked, and what these rows do NOT read. Moved, not rewritten —
        * except for the last clause, which named the missing sweep as *not
        * built yet* and now names it as *coming soon*, because that is the one
        * phrase this wallet uses for anything planned (`screens/explore.tsx`
        * carries the decision). The admission itself is unchanged, and it is
        * the part that matters: the limit is SAID here rather than implied. */}
      <p className="m-0 mt-3 text-xs text-faint">
        Checking asks the indexer about each wallet in turn, one at a time — nothing
        syncs in the background unasked. These rows read the SHIELDED balance only; the
        open wallet&rsquo;s card reads both kinds. A sweep that reads unshielded NIGHT
        too is coming soon — said here rather than implied.
      </p>
      <Button
        className="mt-2 self-start"
        disabled={sweeping}
        onClick={() => { setShowAll(true); sweep(); }}
      >
        {sweeping ? 'Checking every wallet…' : `Check all ${WALLET_ACCOUNTS.length} wallets`}
      </Button>
    </div>
  );
}

/**
 * The switcher, with whatever trigger the caller hands it.
 *
 * `children` is the trigger and goes through `DialogTrigger asChild`, so the
 * caller keeps its own element — the sidebar's `SidebarMenuButton`, the place
 * header's chip, Home's plain button — and this file keeps the behaviour.
 */
export function WalletSwitcher({ identity, secret, children }: {
  readonly identity: Identity;
  readonly secret: Secret;
  readonly children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const { names, account, wallet } = useWallets(secret);

  /* One writer, and every surface hears it. There is no `onSwitched`
   * and no remount: the chip and the home screen are subscribed to the same
   * record through `shell/wallets.ts`, so they re-render on this notification. */
  const switchTo = (next: number): void => {
    setOpen(false);
    if (next === account) return;
    switchWallet(secret, next);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent aria-label="Your wallets">
        <DialogHeader>
          <DialogTitle>Which wallet</DialogTitle>
          {/* THE HEADER IS WHERE THE WALLET IDENTIFIES ITSELF AS A
            * WHOLE, so this is the name of the wallet that HOLDS the rows
            * below, never one of them. The sentence says which is which,
            * because "Main wallet" and "Subwallet 3" are accounts inside it
            * and the copy must not let those two ideas trade places. */}
          {wallet !== null && (
            <p className="m-0 text-sm font-semibold text-ink" data-whole-wallet="">
              {wallet}
            </p>
          )}
          <DialogDescription>
            {wallet !== null && `These are the accounts in ${wallet}. `}
            Every slot exists whether or not it has been used, and each one has its own
            address and its own money.
          </DialogDescription>
        </DialogHeader>
        <WalletList
          identity={identity}
          names={names}
          account={account}
          onSwitch={switchTo}
        />
      </DialogContent>
    </Dialog>
  );
}
