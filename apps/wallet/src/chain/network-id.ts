import { NETWORK } from '../config.js';

/*
 * THE NETWORK THIS WALLET RUNS ON, GIVEN TO THE CONTRACT LIBRARIES ONCE.
 *
 * The libraries that build a contract's transactions keep the network in one
 * place for the whole page, and refuse to build anything until it is set: an
 * address and a transaction both carry it. This wallet has one network, the
 * one written in its own configuration, so that is what it sets. It is never
 * read from a page that asks for something, because a page that could name
 * the network could have this wallet build for another one.
 *
 * Every call of the wallet into a contract's code waits on this first, and it
 * runs once however many wait.
 */
let set: Promise<void> | null = null;

export const walletNetworkIsSet = (): Promise<void> => {
  set ??= import('@midnight-ntwrk/midnight-js-network-id').then(({ setNetworkId }) => { setNetworkId(NETWORK as never); });
  set.catch(() => { set = null; });
  return set;
};
