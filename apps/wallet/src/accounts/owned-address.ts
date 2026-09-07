import { addressFor } from 'midnight-identity';
import type { Identity, PayeeAddress } from 'midnight-identity';
import type { NetworkName } from 'midnight-identity/network';
import { unshieldedAddressFor } from '../chain/unshielded.js';
import {
  MAIN_ACCOUNT, defaultNameOf, displayNameOf, isWalletAccount, slotNumberOf,
} from './subwallets.js';

/**
 * AN ADDRESS AND ITS OWNER, ONE VALUE — the durable half.
 *
 * The failure subwallets invent is paying into the wrong one of your own
 * wallets, and a later reading found its residue: the rule "the name travels
 * with the address" was held at one call site, true only while home is the
 * only screen with an address, and the copy confirmation printed a name two
 * wallets are allowed to share. The shape of the fix is the shape that
 * worked for `PayeeAddress`: when two things must never disagree, make them
 * one value that cannot be constructed apart.
 *
 * So: the ONLY way the app turns a wallet account into a renderable address
 * is this function, and what it returns already carries the owner — the
 * name, and the SLOT, which is the half a shared name drops. The brand is a
 * module-private unique symbol, so no screen (and no test) can conjure an
 * `OwnedAddress` from an object literal with the wrong owner attached; a
 * future screen that wants to show an address either goes through this door
 * and gets the owner with it, or fails to compile.
 *
 * `owner` is the line every surface prints. For a slot wearing its own
 * fixed name ("Subwallet 2", "Main wallet") the name IS the slot, so it
 * stands alone. For a personal name the slot rides along in brackets —
 * "Rent (subwallet 2)" — because two subwallets may share a name and the
 * surface where that matters most is exactly the one deciding whether the
 * right thing was copied.
 */

declare const ownedBrand: unique symbol;

export interface OwnedAddress {
  readonly [ownedBrand]: true;
  /** The SHIELDED address — private payments; what the payroll pays. One
   * decode, both halves — `wallet/address.ts`. */
  readonly address: PayeeAddress;
  /** The UNSHIELDED address — ordinary NIGHT transfers, and the faucet,
   * which rejects shielded and DUST addresses. Derived through the
   * same door the unshielded wallet syncs with, so the address shown and
   * the balance read can never be two different wallets. */
  readonly unshieldedBech32: string;
  /** The slot this address belongs to. Always one the interface offers. */
  readonly account: number;
  /** The person's name for the wallet, or the slot's own fixed name. */
  readonly name: string;
  /** The slot stated as itself: 'main wallet' or 'subwallet N'. */
  readonly slot: string;
  /** Name and slot together — what every surface prints. Never a bare name. */
  readonly owner: string;
}

export function ownedAddressFor(
  identity: Identity,
  account: number,
  names: Readonly<Record<string, string>>,
  network: NetworkName,
): OwnedAddress {
  /* The fourth wall for the reserved account, and the first for slots the
   * interface does not offer at all: `moneyAt` would happily derive account
   * 12, but no screen may show an address the picker cannot reach — that is
   * §2.3's invisible-money trap from the other side. */
  if (!isWalletAccount(account)) {
    throw new Error(`account ${account} is not a wallet this interface offers`
      + (account === 1 ? ' — account 1 is the authority compartment, never a wallet.' : '.'));
  }
  const name = displayNameOf(account, names);
  const slot = account === MAIN_ACCOUNT ? 'main wallet' : `subwallet ${slotNumberOf(account)}`;
  const owner = name === defaultNameOf(account) ? name : `${name} (${slot})`;
  return Object.freeze({
    address: addressFor(identity.moneyAt(account).zswap, network),
    unshieldedBech32: unshieldedAddressFor(identity, account),
    account,
    name,
    slot,
    owner,
  }) as OwnedAddress;
}
