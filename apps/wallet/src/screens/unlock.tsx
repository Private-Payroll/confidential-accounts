import type { ReactNode } from 'react';
import { hrefOf } from '../routes.js';
import { useSession } from '../session.js';
import { walletNameOnRecord } from '../accounts/storage.js';
import { ErrorNote, Moon, StatusNote } from '../components/ui.js';
import { AddAnotherWallet, WalletsHere } from './wallets-here.js';

/**
 * An account is stored here; its keys stay sealed until a passkey opens the
 * UI. The secondary door exists for an ordinary event: the credential
 * deleted from iCloud Keychain or Google Password Manager, leaving this
 * screen's primary button pointing at a passkey that no longer exists —
 * §7.13 is the decision that allows the replacement.
 *
 * WHICH WALLET IS BEING UNLOCKED, WHEN IT HAS A NAME. This is the one
 * screen that cannot check the name against the secret, because the secret is
 * exactly what is still sealed: `walletNameOnRecord` is the unchecked reader
 * `storage.ts` documents for this use and nothing else, and it is only honest
 * because every path that seals a keyring settles that record in the same
 * turn. It decides nothing — it is a label above a button, and the button
 * behaves identically whether or not it is there.
 *
 * AND IT IS NOW SCOPED TO THE COMPARTMENT THIS WINDOW HAS OPEN, which
 * is the only change to the sentence above: the reader takes a wallet, and
 * defaults to the open one.
 *
 * **THIS SCREEN BECOMES THE PLACE A BROWSER'S WALLETS ARE CHOSEN BETWEEN**,
 * and nothing about the unlock itself moves to make room for it. The button
 * is the same button; the ceremony is the same ceremony; `walletOfCredential`
 * resolves whichever credential the browser's own chooser offers, so picking
 * a passkey IS picking a wallet. `WalletsHere` is for the person who would
 * rather point at a name than recognise a credential, and it renders only
 * when there is more than one to point at.
 */
export function Unlock(): ReactNode {
  const { unlock, adoptPasskey, busy, error, wallets, walletId } = useSession();
  /* The compartment this window has open, named explicitly. This is
   * the screen `storage.ts` documents the unchecked reader FOR, and it is
   * now scoped to one wallet rather than to whatever the fixed key held. */
  const wallet = walletNameOnRecord(walletId);
  const several = wallets.length > 1;
  return (
    <div className="hero">
      <Moon large />
      <h1>Welcome back.</h1>
      {wallet !== null && (
        <p className="muted" data-whole-wallet="" style={{ marginTop: '-0.5rem' }}>
          <strong>{wallet}</strong>
        </p>
      )}
      <p className="lede">
        This wallet is locked. Its keys are sealed in this browser and stay that way
        until you unlock.{several && (
          <>
            {' '}This browser holds {wallets.length} wallets — your passkey says which
            one opens.
          </>
        )}
      </p>
      <div className="actions">
        <button
          type="button"
          className="primary big"
          onClick={() => { void unlock(); }}
          disabled={busy !== null}
        >
          Unlock with your passkey
        </button>
        <StatusNote message={busy} />
        <ErrorNote message={error} />
      </div>
      {/*
        * **THE LIST MOVES UP, TO DIRECTLY BENEATH THE BUTTON.**
        *
        * It used to sit last, under two paragraphs of secondary doors, and on a
        * normal window a person with three wallets met one `Unlock with your
        * passkey` and had to scroll to discover the others existed at all. The
        * lede two elements above already says *"This browser holds 3 wallets"*;
        * a sentence that announces something the layout then hides is worse
        * than saying nothing.
        *
        * ORDER IS THE WHOLE FIX, AND IT IS THE SMALLEST ONE AVAILABLE. The
        * alternatives were a shorter hero (the moon and its 2.5rem of padding
        * are the screen's identity, and the screenshot set's pictures are of it) or
        * folding the list into a disclosure (which is `AddAnotherWallet`'s
        * shape, chosen there because acquiring a wallet is not why you came —
        * whereas choosing between wallets you already have IS). Nothing else on
        * the screen moves: the button, the ceremony and the two secondary doors
        * are exactly where they were, in the order they were.
        *
        * The list still renders only when there are at least two wallets, so a
        * browser with one is character-for-character the screen it was.
        */}
      <WalletsHere />
      <p className="faint small" style={{ marginTop: '2.5rem' }}>
        Passkey deleted or not offered any more?{' '}
        <button
          type="button"
          className="quiet"
          onClick={() => { void adoptPasskey(); }}
          disabled={busy !== null}
        >
          Make a new passkey for this wallet
        </button>
      </p>
      <p className="faint small">
        <a href={hrefOf('recover')}>Recovery from your placed pieces</a> also gets
        you back in.
      </p>
      <AddAnotherWallet />
    </div>
  );
}
