/**
 * The provider set for a door that deploys or calls a contract with this machine's own wallet, which pays for its
 * own transactions.
 *
 * Everything that does not depend on who pays comes from `contractProviders`, the one place the service's provider
 * set is built too. The wallet balances every token kind of its own transactions and submits them, through the
 * testkit wallet provider's own `balanceTx` and `submitTx`, so the adopt, sign and finalise steps are the testkit's
 * and not a copy of them. Only those calls and the public halves of the keys reach the provider set: the wallet's
 * secret keys and seeds stay on the wallet object.
 */
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import type { MidnightProvider, MidnightProviders, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import { contractProviders, type ContractProviderBundle } from '../src/midnight/providers.js';

/** The parts of this machine's testkit wallet a door's provider set reaches. */
export type OwnWallet = Pick<
  MidnightWalletProvider,
  'supportedEras' | 'balanceTx' | 'submitTx' | 'getCoinPublicKey' | 'getEncryptionPublicKey'
>;

/** The wallet and submit providers of a set whose own wallet pays for everything it sends. */
export const ownWalletPays = (wallet: OwnWallet): { walletProvider: WalletProvider; midnightProvider: MidnightProvider } => ({
  walletProvider: {
    supportedEras: wallet.supportedEras,
    balanceTx: (tx, ttl) => wallet.balanceTx(tx, ttl),
    getCoinPublicKey: () => wallet.getCoinPublicKey(),
    getEncryptionPublicKey: () => wallet.getEncryptionPublicKey(),
  },
  midnightProvider: {
    supportedEras: wallet.supportedEras,
    submitTx: (tx) => wallet.submitTx(tx),
  },
});

export interface DoorProviderBundle extends ContractProviderBundle {
  wallet: OwnWallet;
}

/** Builds a door's provider set: the service's own members, with this machine's wallet balancing and submitting. */
export async function doorProviders(b: DoorProviderBundle): Promise<MidnightProviders> {
  return { ...(await contractProviders(b)), ...ownWalletPays(b.wallet) };
}
