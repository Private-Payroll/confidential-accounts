import { privateAmount, publicAmount, type PrivateAmount, type PublicAmount } from 'vaults-ui';
import { assets, type AssetId, type AssetRegistry } from '../../../../src/core/assets.js';
import { openWalletDialog, US_TO_A_WALLET } from 'vaults-web-shared/wallet-sign-in.js';
import { walletInThisPage } from 'vaults-web-shared/wallet-frame.js';
import { askWalletForAddressesAndBalances, WalletDidNotShowAddressesAndBalances } from 'vaults-web-shared/wallet-records-key.js';
import type { AddressesAndBalancesShown, HeldAmount, Visibility } from 'midnight-identity/profile/addresses-and-balances';
import { ACCOUNT_ORIGIN } from './session.js';
import { ACT_REFUSAL, refusalOf, type ActRefusal } from './refusals.js';

/*
 * THE SIGNED-IN PERSON'S ACCOUNT: WHERE IT RECEIVES PRIVATELY, AND WHAT IT
 * HOLDS ON EACH SIDE, AS THEIR OWN WALLET SAYS IT ON THEIR PRESS.
 *
 * Every fact here comes from the person's wallet, asked once per call, in a
 * window the person presses Show in; nothing is kept between calls and
 * nothing is watched, so a screen asks again only when the person asks it
 * to. The account's public address is never asked for and never handed on. A
 * token is named only from the asset registry's entry for the side it is held
 * on; anything else is counted as a token this app cannot put in. A side the
 * wallet could not read is not known, never zero. Nothing it hands a screen
 * is wording: codes, and amounts made here.
 */

/** What an ask for the account's balances came to, compared by a screen. */
export const ACCOUNT_BALANCES = { read: 'read', refused: 'refused' } as const;

/** Whether one side of the account was read, compared by a screen. */
export const SIDE = { read: 'read', notKnown: 'not-known' } as const;

/** The two sides of an account, compared by the code. */
export const VISIBILITY = { private: 'private', public: 'public' } as const satisfies Readonly<Record<Visibility, Visibility>>;

/**
 * One token the account holds on one side that this app can put in, under the
 * registry's entry for that side. A row is its side and its token together:
 * one token held on both sides is two rows, one in each side's list, where
 * `code` is unique.
 */
export interface TokenHeld {
  readonly visibility: Visibility;
  /** The registry's entry, which a deposit is picked by. */
  readonly code: AssetId;
  readonly name: string;
  /** Every smallest unit held, exactly as the wallet said: what a deposit's Max and its above-held refusal are checked against. */
  readonly held: bigint;
  /** The same amount, made private or public from the side it is held on, for the screen to show. */
  readonly amount: PrivateAmount | PublicAmount;
}

/** One side of the account: read at `at`, with the tokens this app can put in and a count of those it cannot; or not known. */
export type SideHeld =
  | {
    readonly of: typeof SIDE.read; readonly at: number;
    readonly tokens: readonly TokenHeld[];
    /** Tokens held above zero on this side that the registry does not name for it: counted, never offered. */
    readonly cannotPutIn: number;
  }
  | { readonly of: typeof SIDE.notKnown };

/** The account's private address and both sides, as the wallet said at `at`; or why there is nothing. */
export type AccountBalances =
  | {
    readonly of: typeof ACCOUNT_BALANCES.read; readonly at: number;
    readonly privateAddress: string;
    readonly private: SideHeld; readonly public: SideHeld;
  }
  | { readonly of: typeof ACCOUNT_BALANCES.refused; readonly why: ActRefusal };

/** The ledger's word for each side. */
const FORM = { private: 'shielded', public: 'unshielded' } as const satisfies Readonly<Record<Visibility, 'shielded' | 'unshielded'>>;

/** One side of what the wallet showed: each token named by the registry's entry for that side, in the registry's order, and the rest counted. */
function sideOf(shown: AddressesAndBalancesShown, visibility: Visibility, registry: AssetRegistry): SideHeld {
  const at = shown.read[visibility];
  if (at === null) return { of: SIDE.notKnown };
  const tokens: (TokenHeld & { readonly order: number })[] = [];
  let cannotPutIn = 0;
  for (const b of shown.balances.filter((x: HeldAmount) => x.visibility === visibility)) {
    const held = BigInt(b.amount);
    const asset = registry.find(b.token);
    if (asset === null || !asset.enabled || asset.ledger[FORM[visibility]] !== b.token) {
      if (held > 0n) cannotPutIn += 1;
      continue;
    }
    tokens.push({
      visibility, code: asset.code, name: asset.name, held,
      amount: visibility === VISIBILITY.private
        ? privateAmount(held, asset.decimals, asset.symbol)
        : publicAmount(held, asset.decimals, asset.symbol),
      order: asset.sortOrder,
    });
  }
  tokens.sort((a, b) => a.order - b.order);
  return { of: SIDE.read, at, tokens: tokens.map(({ order: _order, ...t }) => t), cannotPutIn };
}

/** What the wallet showed, as a screen takes it. */
export function accountBalancesFrom(shown: AddressesAndBalancesShown, at: number, registry: AssetRegistry = assets): AccountBalances {
  return {
    of: ACCOUNT_BALANCES.read, at, privateAddress: shown.addresses.private,
    private: sideOf(shown, VISIBILITY.private, registry), public: sideOf(shown, VISIBILITY.public, registry),
  };
}

/**
 * ASKS THE PERSON'S WALLET, ONCE, FOR THE ACCOUNT'S PRIVATE ADDRESS AND
 * BALANCES, the page named to the wallet as `US_TO_A_WALLET` names it, as the
 * window to pay into a vault names it. The wallet opens in
 * this page and hands them over only on the person's press. Refused, with the
 * code a screen words: no wallet set up for this app, the person declined or
 * the window went, or an answer this page does not believe (another page's,
 * another ask's, one not whole, or one carrying the public address), which is
 * `unreadable`.
 */
export async function askForAccountBalances(registry: AssetRegistry = assets): Promise<AccountBalances> {
  if (ACCOUNT_ORIGIN === '') return { of: ACCOUNT_BALANCES.refused, why: ACT_REFUSAL.notSetUp };
  const view = walletInThisPage(window);
  const dialog = openWalletDialog(view, ACCOUNT_ORIGIN);
  try {
    const { shown, at } = await askWalletForAddressesAndBalances(view, ACCOUNT_ORIGIN, {
      atOrigin: window.location.origin, name: US_TO_A_WALLET.name, rdns: US_TO_A_WALLET.rdns,
    }, dialog);
    return accountBalancesFrom(shown, at, registry);
  } catch (e) {
    return {
      of: ACCOUNT_BALANCES.refused,
      why: e instanceof WalletDidNotShowAddressesAndBalances ? ACT_REFUSAL.unreadable : refusalOf(e),
    };
  } finally {
    dialog.giveUp();
  }
}
