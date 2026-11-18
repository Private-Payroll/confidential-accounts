/**
 * Registering a wallet's own NIGHT so that it generates the DUST fees are paid in.
 *
 * Unregistered NIGHT generates no DUST on the chain. A registration is credited the DUST its NIGHT would have
 * generated since it was created (up to the cap), and pays its own fee out of that; the wallet projects it, and counts
 * no more of it than its single largest NIGHT coin would give. So the fee is estimated first, and the registration is
 * built only once that projection covers it. Which NIGHT is unregistered is read from the wallet's state after the wallet (or the sides the caller names) has
 * synced, never from an earlier reading, and the wallet's own DUST address is named as the receiver.
 *
 * It moves no money: a registration's NIGHT goes back to the address that owns it, and only NIGHT is ever registered.
 * It is for the fee payer's own wallet and for test wallets; it never holds or moves a company's money.
 */
import type { WalletFacade } from '@midnightntwrk/wallet-sdk';
import { NIGHT } from '../core/assets.js';

type RegisterArguments = Parameters<WalletFacade['registerNightUtxosForDustGeneration']>;
type NightCoin = RegisterArguments[0][number];
type UnprovenRegistration = Awaited<ReturnType<WalletFacade['registerNightUtxosForDustGeneration']>>;
type SyncedState = Awaited<ReturnType<WalletFacade['waitForSyncedState']>>;

/** The wallet a registration is built, proved and sent through. */
export type DustRegistrationWallet = Pick<
  WalletFacade,
  | 'waitForSyncedState'
  | 'estimateRegistration'
  | 'waitForGeneratedDust'
  | 'registerNightUtxosForDustGeneration'
>;

/** Who owns the NIGHT: its verifying key, and what signs the registration with the matching secret. */
export interface NightOwner {
  readonly verifyingKey: RegisterArguments[1];
  readonly sign: RegisterArguments[2];
}

export interface DustRegistrationOptions {
  /** How long to wait for the generated DUST to cover the fee, in ms. Absent, the wallet's own limit applies. */
  readonly waitMs?: number;
  /**
   * Proves and sends the signed registration, answering its transaction id. Required, because what a failed send must
   * do with the NIGHT coins the wallet booked for it differs by wallet: the wallet's own submit gives them back, a
   * chain the caller drives itself decides for itself. Each caller says which.
   */
  readonly send: (registration: UnprovenRegistration) => Promise<string>;
  /**
   * Waits for the two sides a registration reads, the NIGHT coins and the DUST address, in place of the whole
   * wallet's sync. Absent, the whole wallet is waited for, the shielded side included.
   */
  readonly synced?: () => Promise<Pick<SyncedState, 'unshielded' | 'dust'>>;
}

/** What was registered: nothing, when every NIGHT coin already was; otherwise how many coins, the fee, and the transaction. */
export type DustRegistration =
  | { readonly registered: 0 }
  | { readonly registered: number; readonly fee: bigint; readonly transaction: string };

/** The wallet's NIGHT coins not yet registered, read off a synced state. Other tokens are never registered. */
export const unregisteredNight = (coins: readonly NightCoin[]): NightCoin[] =>
  coins.filter((coin) => coin.utxo.type.toLowerCase() === NIGHT && !coin.meta.registeredForDustGeneration);

/**
 * Registers every NIGHT coin of this wallet that is not yet registered, once the DUST it generates covers the
 * registration's fee. Answers `{ registered: 0 }` when there is nothing to register. Refuses (with the wallet's own
 * error) when the generated DUST does not cover the fee within the wait.
 */
export async function registerNightForDust(
  wallet: DustRegistrationWallet,
  owner: NightOwner,
  options: DustRegistrationOptions,
): Promise<DustRegistration> {
  const synced = options.synced ? await options.synced() : await wallet.waitForSyncedState();
  const coins = unregisteredNight(synced.unshielded.availableCoins);
  if (coins.length === 0) return { registered: 0 };

  const { fee } = await wallet.estimateRegistration(coins);
  await wallet.waitForGeneratedDust(coins, fee, options.waitMs === undefined ? undefined : { timeoutMs: options.waitMs });
  const registration = await wallet.registerNightUtxosForDustGeneration(
    coins, owner.verifyingKey, owner.sign, synced.dust.address,
  );
  return { registered: coins.length, fee, transaction: await options.send(registration) };
}
