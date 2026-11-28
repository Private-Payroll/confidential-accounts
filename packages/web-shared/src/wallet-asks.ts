/**
 * The asks this page makes of the person's own wallet, and the way it shows that it is waiting for one. A press opens
 * the wallet's window before the page does anything else, the screen draws "waiting for your wallet" while any ask is
 * open, and the window is put away when the ask fails. Here are the wallet's asks that need no more of the page than
 * that: put coins into a vault, sign a change to who holds a company's rules, sign the records key, and read who holds
 * a company now.
 */
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
import { sessionIsLive } from './service-transport.js';
import { openWalletDialog, US_TO_A_WALLET, type Openable, type WalletDialog } from './wallet-sign-in.js';
import { askWalletToPay } from './wallet-balance.js';
import { askWalletToSignCommittee, type CommitteeAsked } from './wallet-committee.js';
import {
  askWalletToSignRecordsKey,
  askWalletWhoHolds,
  type HoldersAsked,
  type HoldersRead,
  type RecordsKeyAsked,
  type RecordsKeySigned
} from './wallet-records-key.js';
import { walletInThisPage, walletQuietlyInThisPage } from './wallet-frame.js';

/**
 * **THE PAGE BEHIND THE DIALOG HAS TO SHOW THAT IT IS WAITING.**
 *
 * A person who presses a button, sees nothing change, and cannot see the window
 * that opened behind their browser presses it again — and a second press is a
 * second ask. So every wallet ask opens its dialog through `openTheWallet`, here
 * and in the other modules that ask the wallet, and so announces itself: the
 * screen subscribes once, draws *waiting for your wallet* while a dialog is
 * open, and offers the way out that `WalletDialog.giveUp` is.
 *
 * It is a subscription rather than a parameter because the asks are started
 * from four different places on three different screens, and a callback
 * threaded through all of them is a callback one of them forgets.
 */
type WalletWaiting = (dialog: WalletDialog | null) => void;

const watching = new Set<WalletWaiting>();

/** Returns the way to stop watching. Call it from an effect's cleanup. */
export function onWalletWaiting(watch: WalletWaiting): () => void {
  watching.add(watch);
  return () => {
    watching.delete(watch);
  };
}

const nowWaiting = (dialog: WalletDialog | null): void => {
  for (const watch of watching) watch(dialog);
};

/**
 * **THE WINDOW IS OPENED HERE, AND EVERY CALLER CALLS THIS BEFORE ITS FIRST
 * `await`.** That is the whole repair, and it is one line at each of
 * the four call sites rather than a rule written down somewhere.
 *
 * `already` is the dialog a longer journey opened in its own click — creating a
 * company opens the wallet in the press, then talks to this server, then asks
 * the wallet — so the second half does not open a second window.
 */
export function openTheWallet(view: Openable, walletOrigin: string, already?: WalletDialog): WalletDialog {
  const dialog = already ?? openWalletDialog(view, walletOrigin);
  nowWaiting(dialog);
  return dialog;
}

/** Nothing is waiting on a wallet any more, however it ended. */
export const doneWaiting = (): void => {
  nowWaiting(null);
};

/**
 * **A JOURNEY THAT OPENS ITS OWN DIALOG ANNOUNCES IT HERE.** Accepting an
 * invitation drives two asks through one dialog it owns, so it does not come
 * through `openTheWallet` - and a wallet shown with no dialog announced has a
 * *Stop waiting* that can hide the wallet but cannot refuse the ask in flight.
 * Returns the way to stop announcing; call it when the journey ends.
 */
export function showWaitingFor(dialog: WalletDialog): () => void {
  nowWaiting(dialog);
  return doneWaiting;
}

/**
 * **A JOURNEY THAT FAILED PUTS ITS WALLET AWAY BEFORE IT STOPS SAYING IT IS WAITING.**
 *
 * Every wallet journey opens the wallet in the press and then talks to this
 * server. When that talk fails the ask never ran, so nothing closed the wallet
 * - and `doneWaiting` then removed the one control that could, leaving a wallet
 * on screen with nothing able to put it away. `giveUp` is safe after anything:
 * an ask that already ended has already closed it, and a second close is not a
 * second event.
 */
export const putAway = (dialog: WalletDialog): void => {
  dialog.giveUp();
};

/**
 * **ASKS THIS PERSON'S WALLET TO PUT IN THE COINS A DEPOSIT NEEDS.** Opened in
 * the press, like every wallet journey; see `wallet-balance.ts`.
 */
export async function payIntoAVaultFromTheWallet(
  walletOrigin: string,
  ask: { company: CompanyLabel; account: AccountAddress; vault: VaultAddress; transaction: string },
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
  already?: WalletDialog
): Promise<{ transaction: string; leaves: readonly unknown[] }> {
  if (!sessionIsLive()) throw new Error('not signed in');
  const dialog = openTheWallet(view, walletOrigin, already);
  try {
    return await askWalletToPay(
      view,
      walletOrigin,
      {
        ...ask,
        atOrigin,
        name: US_TO_A_WALLET.name,
        rdns: US_TO_A_WALLET.rdns
      },
      dialog
    );
  } catch (e) {
    if (!already) putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
  }
}

/**
 * **ASKS THIS PERSON'S WALLET TO SIGN A CHANGE TO WHO HOLDS THEIR COMPANY'S
 * RULES.** Opened in the press, like every wallet journey; see
 * `wallet-committee.ts`.
 */
export async function signCommitteeChangeFromTheWallet(
  walletOrigin: string,
  ask: Pick<CommitteeAsked, 'company' | 'account' | 'to' | 'contracts'>,
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
  already?: WalletDialog
): Promise<Awaited<ReturnType<typeof askWalletToSignCommittee>>> {
  if (!sessionIsLive()) throw new Error('not signed in');
  const dialog = openTheWallet(view, walletOrigin, already);
  try {
    return await askWalletToSignCommittee(
      view,
      walletOrigin,
      {
        ...ask,
        atOrigin,
        name: US_TO_A_WALLET.name,
        rdns: US_TO_A_WALLET.rdns
      },
      dialog
    );
  } catch (e) {
    if (!already) putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
  }
}

/**
 * **THIS PERSON'S RECORDS KEY FOR THEIR SEAT, SIGNED BY THEIR OWN WALLET, AND WHO
 * HOLDS THE COMPANY'S ACCOUNT NOW AS THAT WALLET READ IT.** Asked right before a
 * vault's secret is approved, so what it is checked against is read then.
 * With `firstSecret`, asked before a vault's first secret, the wallet also
 * shows the person that vault and every reader its secret will be sealed to:
 * a confirmation for the person, not a lock, since the chain accepts the
 * approval on the seat's proof this page makes.
 * Opened in the press, like every wallet journey; see `wallet-records-key.ts`.
 */
export async function recordsKeyFromTheWallet(
  walletOrigin: string,
  ask: Pick<RecordsKeyAsked, 'company' | 'account' | 'seat' | 'vault' | 'signingKey' | 'invitedBy' | 'firstSecret'>,
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin,
  already?: WalletDialog
): Promise<RecordsKeySigned> {
  if (!sessionIsLive()) throw new Error('not signed in');
  const dialog = openTheWallet(view, walletOrigin, already);
  try {
    return await askWalletToSignRecordsKey(
      view,
      walletOrigin,
      {
        ...ask,
        atOrigin,
        name: US_TO_A_WALLET.name,
        rdns: US_TO_A_WALLET.rdns
      },
      dialog
    );
  } catch (e) {
    if (!already) putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
  }
}

/**
 * The indexer this person's wallet last named in an answer it gave in this tab: the wallet names it only with an
 * answer it completes, never with a refusal. Null until it has named one.
 */
let walletsIndexer: { readonly indexerUri: string; readonly indexerWsUri: string } | null = null;

/** The indexer this person's wallet last named in this tab, or null until it has named one. */
export const walletsIndexerNamed = (): typeof walletsIndexer => walletsIndexer;

/** The indexer the wallet named belongs to the sign-in it was learnt in, so it is dropped with that sign-in. */
export const forgetTheWalletsIndexer = (): void => {
  walletsIndexer = null;
};

/**
 * **WHO HOLDS THE COMPANY NOW, AS THIS PERSON'S OWN WALLET READS THE CHAIN**, with
 * no press. Asked afresh for every read that believes a filing; see
 * `wallet-records-key.ts`. Nothing is shown and nothing is unlocked: the wallet
 * is asked in a frame of its own that nobody sees (`walletQuietlyInThisPage`),
 * and the page says it is waiting for nothing.
 */
export async function holdersFromTheWallet(
  walletOrigin: string,
  ask: Pick<HoldersAsked, 'company' | 'account' | 'movements' | 'roles'>,
  view: Openable = walletQuietlyInThisPage(window),
  atOrigin: string = window.location.origin
): Promise<HoldersRead> {
  if (!sessionIsLive()) throw new Error('not signed in');
  const dialog = openWalletDialog(view, walletOrigin);
  try {
    const read = await askWalletWhoHolds(
      view,
      walletOrigin,
      {
        ...ask,
        atOrigin,
        name: US_TO_A_WALLET.name,
        rdns: US_TO_A_WALLET.rdns
      },
      dialog
    );
    if (read.indexer !== null) walletsIndexer = read.indexer;
    return read;
  } finally {
    putAway(dialog);
  }
}
