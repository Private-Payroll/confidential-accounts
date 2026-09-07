import { useSyncExternalStore } from 'react';
import type { Secret } from 'midnight-identity';
import {
  loadSubwallets, saveLastUsedWallet, saveSubwalletName, saveWalletName, walletNameOf,
} from '../accounts/storage.js';
import { MAIN_ACCOUNT, isWalletAccount } from '../accounts/subwallets.js';

/**
 * WHICH WALLET IS OPEN — one record, one subscription, two readers.
 *
 * §3. THE RULE: *"An earlier shell left the open wallet in `screens/home.tsx`'s
 * state, so the chip re-reads storage after EVERY CLICK IN THE DOCUMENT —
 * honest, pinned, documented, and a workaround."* This file is the retirement
 * of that workaround, and the click listener is gone.
 *
 * WHAT THE DEFECT ACTUALLY WAS, because the fix follows from it. Two surfaces
 * named the open wallet: the home screen, which held it in `useState` and
 * re-read `lastUsed` only when it MOUNTED, and the chip, which had no way to
 * hear about a switch made on the other one. `storage.ts` is frozen and emits
 * no change event, so the chip subscribed to `document` clicks — every switch
 * is a press, and `saveLastUsedWallet` runs synchronously inside the handler,
 * so a re-read as the click finished bubbling was correct. It was also a
 * document-wide listener firing on every click in the wallet for a fact that
 * changes when one of eleven buttons is pressed.
 *
 * THE VALUE IS NOT COPIED ANYWHERE, AND THAT IS THE POINT. The design
 * says *"one value ... read by the chip and the screen alike"*, and the one
 * value is **the stored record**. This module adds no second copy of it: it
 * adds the change event `storage.ts` cannot emit, so both readers re-derive
 * from the same record at the same moment. A copy held in a provider would be
 * a SECOND place the answer lives, which is the shape of the defect rather
 * than the shape of its fix — and this is what two surfaces disagreeing about
 * which wallet is open looks like when money is involved.
 *
 * SO `screens/home.tsx`'s STANDING RULE IS UNCHANGED AND STILL TRUE: *"the
 * selection lives in STORAGE."* What changes is that a write now says so.
 *
 * `storage.ts` IS UNTOUCHED. Every write below goes through its existing
 * writers, which keep their own refusals — `saveLastUsedWallet` and
 * `saveSubwalletName` both reject account 1 on disk, which is the wall this
 * file's guard stands in front of rather than replaces.
 */

export interface Wallets {
  readonly names: Readonly<Record<string, string>>;
  /** Always a wallet this interface offers — never account 1. */
  readonly account: number;
  /**
   * THE NAME OF THE WHOLE WALLET, or null. **Not one of `names`**:
   * those are the accounts INSIDE this wallet, this is the wallet that holds
   * them. It rides in the same snapshot so that renaming the wallet notifies
   * the same subscribers a switch or an account rename does — two surfaces
   * printing different names for one wallet is the disagreement this module
   * exists to prevent, whichever kind of name it is.
   */
  readonly wallet: string | null;
}

/**
 * THE CHANGE EVENT `storage.ts` DOES NOT HAVE.
 *
 * A `Set` rather than an array so a component that subscribes twice under
 * StrictMode's double-invoke does not get notified twice, and so unsubscribing
 * is not a linear scan.
 */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

/** Iterated over a COPY: a listener that unsubscribes while being notified —
 * a component unmounting because the switch it just made replaced it — would
 * otherwise mutate the set mid-iteration. */
function changed(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * The stored selection, live. The snapshot is a STRING because
 * `useSyncExternalStore` compares snapshots by identity and a fresh object
 * every render is an infinite loop; the record is small and it is parsed once
 * per read by the caller below.
 *
 * IT IS READ FROM STORAGE ON EVERY RENDER, not cached, and that is deliberate:
 * a cache would be the second copy this file exists to avoid, and
 * `loadSubwallets` is a `localStorage` read and a `JSON.parse` of a few hundred
 * bytes — cheaper than the address derivation every caller does with the result.
 */
export function useWallets(secret: Secret): Wallets {
  const raw = useSyncExternalStore(
    subscribe,
    () => JSON.stringify({ ...loadSubwallets(secret), wallet: walletNameOf(secret) }),
  );
  const stored = JSON.parse(raw) as {
    names: Record<string, string>; lastUsed: number; wallet: string | null;
  };
  return {
    names: stored.names,
    wallet: stored.wallet,
    /* A record can only store accounts the validators allow, but the fixed set
     * is this interface's own convention — anything outside it opens the main
     * wallet rather than a slot no screen offers. */
    account: isWalletAccount(stored.lastUsed) ? stored.lastUsed : MAIN_ACCOUNT,
  };
}

/**
 * SWITCH. The interface-level half of the account-1 rule: the pickers are
 * built from `WALLET_ACCOUNTS` and can never offer it, and this refusal makes
 * a future caller that tries one a defect rather than a wallet. The library
 * refuses account 1 at derivation (`moneyAt`) and `storage.ts` refuses it on
 * disk, so this is the third wall, not the only one.
 *
 * It THROWS rather than returning false, which is what `screens/home.tsx` did
 * before this file existed: a caller asking for a wallet this interface does
 * not have has a bug, and a silently ignored switch is a person looking at the
 * wrong wallet's address.
 */
export function switchWallet(secret: Secret, next: number): void {
  if (!isWalletAccount(next)) {
    throw new Error(`account ${next} is not a wallet this interface offers`
      + (next === 1 ? ' — account 1 is the authority compartment, never a wallet.' : '.'));
  }
  saveLastUsedWallet(secret, next);
  changed();
}

/** RENAME. Names are decoration this browser remembers
 * — losable without losing money — but they travel with the address on
 * the card, in the copy confirmation and in the picker, so every surface has
 * to hear about a change at once. */
export function renameWallet(secret: Secret, account: number, name: string): void {
  saveSubwalletName(secret, account, name);
  changed();
}

/**
 * RENAME THE WHOLE WALLET. The same one-writer rule as `renameWallet`
 * above, for a name that appears in more places than an account's does: the
 * switcher's header, the account chip on every place, and the unlock screen.
 *
 * **IT DOES NOT REACH THE PASSKEY.** The label in the browser's chooser was
 * fixed when the credential was created and no web application can change it
 * (`session.tsx`, `credentialLabel`). Every screen that offers this control
 * has to say so — a rename screen that implies a power it does not have is
 * the same class of lie as a comment claiming privacy beside a line that
 * hands the key over.
 */
export function renameThisWallet(secret: Secret, name: string): void {
  saveWalletName(secret, name);
  changed();
}
