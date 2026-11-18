import { useState } from 'react';
import type { ReactNode } from 'react';
import { shortPayee } from 'midnight-identity';
import { shortUnshielded } from '../chain/unshielded.js';
import type { OwnedAddress } from '../accounts/owned-address.js';
import { hrefOf } from '../routes.js';
import { splitShortAddress } from '../accounts/short-address.js';
import { Mark } from '../shell/mark.js';
import { CopyButton } from '../components/ui.js';
import { QrPanel } from '../components/qr.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from 'vaults-ui';
import { ShortcutTile, ShortcutTiles } from '../components/rows.js';
import { GLYPH } from '../glyphs.js';
import { FAUCET_NAME } from './network-words.js';

/* -------------------------------------------------------- the quick actions */

/**
 * FIVE SHORTCUTS, AND THE DIFFERENCE BETWEEN THEM IS THE ARCHITECTURE.
 *
 * **Send is a LINK and will never be a popup.** The interface's
 * first standing rule: *one surface approves anything that moves money*. Every
 * confirmation row in the sequence lives on that surface
 * — and a modal is exactly where a second approval path gets built by accident.
 * A later change redesigns that screen; this one only points at it.
 *
 * **Receive is a popup** because it moves nothing: an address, a code and a copy
 * control, with no approval path anywhere near it.
 *
 * **Earn is a popup that ships**, and is not a placeholder to remove — see
 * `EarnRow` below.
 *
 * **The address book is a shortcut to a DESTINATION**, not an inline drawer.
 * Build it as a drawer now and converting it to a route later
 * is a rewrite. Its route shows `notbuilt` until the book exists; the shortcut is real.
 *
 * **Contacts and My profile are doors to other screens**, beside the others
 * rather than instead of them.
 */
export function QuickActions({ owned }: { readonly owned: OwnedAddress }): ReactNode {
  return (
    <ShortcutTiles aria-label="Shortcuts">
      <ShortcutTile
        href={hrefOf('send')}
        glyph={GLYPH.send}
        tone="accent"
        label="Send"
        says="Pay somebody from this wallet"
      />
      <ReceiveRow owned={owned} />
      <EarnRow />
      {/* THE TILE SAYS *Contacts*; THE ROUTE IS STILL `address-book`. The
        * words on a tile are what a person reads and the route name is what
        * the code and every recorded hash refer to — renaming the second to
        * follow the first would change a URL people may already have. */}
      <ShortcutTile
        href={hrefOf('address-book')}
        glyph={GLYPH.contacts}
        label="Contacts"
        says="People you pay, so an address is never typed twice"
      />
      {/*
        * MY PROFILE — A DOOR, ADDED BESIDE THE OTHERS RATHER THAN INSTEAD OF
        * ONE. `#/profile` existed and was reachable only from Settings, which
        * is two clicks and a guess; a person who has typed their name in once
        * looks for it where the wallet's other shortcuts are.
        *
        * **IT IS STILL NOT A PLACE.** The design keeps the
        * navigation at four on purpose. A shortcut is a door, and adding one
        * does not widen what the bottom bar or the rail holds.
        *
        * `quiet`, like its neighbours — **Send is the one accented tile on
        * this screen** and a second accent is no hierarchy at all.
        */}
      <ShortcutTile
        href={hrefOf('profile')}
        glyph={GLYPH.details}
        label="My profile"
        says="A company can ask; you decide what it gets"
      />
    </ShortcutTiles>
  );
}

/**
 * RECEIVE — the address, a code, and a copy control per address. Display only.
 *
 * TWO ADDRESSES, NOT ONE, AND UNSHIELDED FIRST. The design says *"address,
 * a QR, one copy control"*; this wallet has two payable addresses and
 * that showing only one is how 5000 tNIGHT once landed somewhere the interface
 * could not see. So it is one copy control PER ADDRESS, and dropping either
 * would delete a closed row's assertion rather than move it.
 *
 * The card takes an `OwnedAddress` and nothing else. There is no prop to
 * hand it a bare address, so the owner cannot be dropped or mismatched here or
 * by any future caller.
 */
function ReceiveRow({ owned }: { readonly owned: OwnedAddress }): ReactNode {
  const { address, unshieldedBech32, name, slot, owner } = owned;
  /* CONTROLLED RATHER THAN `DialogTrigger asChild`, AND IT IS A REAL
   * CONSTRAINT RATHER THAN A PREFERENCE. `asChild` goes through Radix's `Slot`,
   * which clones the child and hands it the trigger's own props and ref. `Slot`
   * can only do that to a component that SPREADS what it is given —
   * the kit's `Button` does, which is why the switcher's trigger is a `Button` —
   * and `RowItem` (`components/rows.tsx`) deliberately does not: it takes a fixed prop list so
   * a row cannot acquire arbitrary attributes at a call site. So the row keeps
   * its own `onClick` and this component owns the open state. Radix still
   * returns focus to the row on close, because it remembers what was focused
   * when the dialog opened rather than what the trigger was. */
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <ShortcutTile
        onClick={() => setOpen(true)}
        glyph={GLYPH.receive}
        tone="accent"
        label="Receive"
        says="Your address and a code to scan"
      />
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Receive into {name}</DialogTitle>
          <DialogDescription>
            Nothing here moves money. Both addresses below are real and payable on{' '}
            {address.network}; when comparing either, check <strong>both ends</strong>:
            every address on this network starts with the same run of characters.
          </DialogDescription>
        </DialogHeader>
        <p className="wallet-owner m-0 flex items-center gap-2">
          <Mark address={address.bech32} account={owned.account} size={22} />
          <strong className="text-sm font-semibold text-foreground">{name}</strong>
          {owner !== name && <span className="text-xs text-muted-foreground">{slot}</span>}
        </p>
        <AddressBlock
          kind="unshielded"
          title="Unshielded NIGHT"
          says={(
            <>
              Ordinary NIGHT transfers pay here
              {FAUCET_NAME !== null && (
                <>
                  {', '}and the {FAUCET_NAME} pays <strong>only</strong> here: it
                  rejects shielded and DUST addresses
                </>
              )}
              .
            </>
          )}
          bech32={unshieldedBech32}
          short={shortUnshielded(unshieldedBech32)}
          owner={owner}
        />
        <AddressBlock
          kind="shielded"
          title="Shielded"
          says="Private payments, what this product’s payroll pays. A private payment to this address hides its amount on the chain. A public mint to it shows its amount."
          bech32={address.bech32}
          short={shortPayee(address)}
          owner={owner}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * One renderer for both strings, so neither can quietly lose its
 * both-ends treatment or the owner in its copy confirmation.
 *
 * THE TYPOGRAPHY CLASSES ARE `app.css`'s AND STAY THERE. `.address-short`,
 * `.net`, `.end` and `.address-full` are how an address is drawn in this
 * wallet, and the all-wallets card draws `.address-full` the same way. Moving
 * them into the kit would be a change to both screens, which is not this one.
 */
function AddressBlock({ kind, title, says, bech32, short, owner }: {
  readonly kind: 'unshielded' | 'shielded';
  readonly title: string;
  readonly says: ReactNode;
  readonly bech32: string;
  readonly short: string;
  readonly owner: string;
}): ReactNode {
  const parts = splitShortAddress(short);
  return (
    <div data-addr={kind} className="rounded-md border border-border p-3">
      <h3 className="m-0 text-sm font-semibold text-foreground">{title}</h3>
      <p className="m-0 mt-1 text-xs text-muted-foreground">{says}</p>
      <div
        className="address-short"
        aria-label={`${title} address of ${owner}, short form: ${short}`}
      >
        <span className="net">{parts.network}</span>
        <span className="end">{parts.head}</span>
        {parts.tail !== null && (
          <>
            <span className="gap">…</span>
            <span className="end">{parts.tail}</span>
          </>
        )}
      </div>
      {/* Capped: at the panel's full width the second address block is pushed
        * off the popup, and a code this size still scans. */}
      <div className="max-w-[10rem]">
        <QrPanel
          payload={bech32}
          caption={`${title} address of ${owner}, as a code to scan`}
          testId={`receive-${kind}`}
          bare
        />
      </div>
      <CopyButton
        kit
        text={bech32}
        label={`Copy the ${kind} address`}
        copied={`Copied: the ${kind} address of ${owner}`}
      />
      <details className="reveal" style={{ marginTop: '0.6rem' }}>
        <summary>Show the whole address</summary>
        <p className="muted small" style={{ margin: '0.5rem 0 0.25rem' }}>
          The full {kind} address of {owner}:
        </p>
        <div className="address-full">{bech32}</div>
      </details>
    </div>
  );
}

/**
 * EARN — COMING SOON, AND IT SHIPS. The roadmap is visible on purpose and
 * roadmap signalling in a wallet is ordinary. **This is not a placeholder
 * somebody forgot to remove, and the next person to read this file should not
 * "fix" it by deleting it.**
 *
 * **THE WORDS WERE DECIDED THE OTHER WAY, AND THIS COMMENT IS CORRECTED RATHER
 * THAN LEFT TO BE RE-LITIGATED.** It used to argue that *"Coming soon"* puts a
 * date in the reader's head that nobody has committed to, and this popup said
 * *Not built yet* instead. Then `screens/explore.tsx` shipped six tiles saying
 * *Coming soon* and named the disagreement rather than absorbing it — *"one of
 * the two should win, and this file is not where that is decided."* It is
 * decided: **Coming soon is the wording, everywhere a planned feature is
 * named.** Two rooms of one wallet using two phrases for one state is worse
 * than either phrase, and the argument against this one was never that it was
 * false — only that it was warmer than the alternative.
 *
 * WHAT THE OLD COMMENT WAS RIGHT ABOUT IS KEPT AND IS THE PART UNDER TEST.
 * **The test is whether the sentence is still true in a year**, so nothing
 * here names a month, a quarter, a season or a version, and the body still
 * says outright that there is no date and this screen will not invent one.
 * *Soon* is a temperature; *Q3* is a promise. Only the second is forbidden.
 *
 * NOT `screens/notbuilt.tsx`. That screen is about a ROUTE WITH NO SCREEN
 * BEHIND IT — a different statement, in different words, and untouched.
 */
function EarnRow(): ReactNode {
  /* Controlled for the same reason `ReceiveRow` is — see the note there. */
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <ShortcutTile
        onClick={() => setOpen(true)}
        glyph={GLYPH.earn}
        label="Earn"
        says="Coming soon"
      />
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Earn is coming soon</DialogTitle>
          <DialogDescription>
            This is where staking and yield will live: putting NIGHT to work without
            handing it to anybody.
          </DialogDescription>
        </DialogHeader>
        <p className="m-0 text-sm text-muted-foreground">
          There is no date for it and this screen will not invent one. When it exists it
          will name every host it dials, the way the rest of this wallet does, and
          nothing will move without going through the same approval screen a payment
          does.
        </p>
      </DialogContent>
    </Dialog>
  );
}
