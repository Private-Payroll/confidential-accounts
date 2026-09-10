import type { Opened } from 'midnight-identity/profile/seal';

/**
 * **WHAT TO TELL A PERSON WHOSE WALLET CANNOT OPEN THE DETAILS KEPT HERE.**
 *
 * This browser keeps ONE set of saved details, sealed under the key of the
 * wallet that saved them, and it can hold several wallets. So in a browser
 * holding more than one, a wallet that did not save the details meets a blob
 * that will not open with its key - the ordinary case, every time a second
 * wallet is used here. Telling that person the details *belong to another
 * account, or they have been altered* raises tampering over something the
 * browser's own layout explains.
 *
 * The explanation is offered only when it is available: the failure is the key
 * one, and this browser holds more than one wallet. It is still worded as the
 * likely cause and not the certain one, because a blob that another wallet
 * sealed and a blob somebody altered fail in the same way. Every other failure
 * keeps the library's own sentence and its warning.
 */
export interface UnopenableSaying {
  readonly title: string;
  readonly sentence: string;
  readonly tone: 'info' | 'danger';
  /** True when the sentence names another wallet in this browser as the likely cause. */
  readonly anotherWalletHere: boolean;
}

export function sayingForUnopenable(
  opened: Extract<Opened, { of: 'unopenable' }>,
  walletsInThisBrowser: number,
): UnopenableSaying {
  if (opened.cause === 'another-key' && walletsInThisBrowser > 1) {
    return {
      title: 'The details kept in this browser are not this wallet\'s',
      sentence: `This browser holds ${walletsInThisBrowser} wallets and keeps one set of saved `
        + 'details for all of them. These will not open with this wallet\'s key, so they were most '
        + 'likely saved by another wallet used in this browser.',
      tone: 'info',
      anotherWalletHere: true,
    };
  }
  return {
    title: 'There are details here that this account cannot open',
    sentence: opened.why,
    tone: 'danger',
    anotherWalletHere: false,
  };
}
