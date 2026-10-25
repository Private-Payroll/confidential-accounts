import type { SeatOpening } from 'midnight-identity/profile/records-key';

/**
 * How the wallet works out the leaf a seat's opening makes: the account's own
 * `signerLeaf`, from the compiled contract this wallet already loads. Replaceable
 * so a test can answer. Resolves to lower-case hex.
 */
export type LeafReader = (opening: SeatOpening) => Promise<string>;

const hexBytes = (h: string): Uint8Array => Uint8Array.from(h.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));

/** The account's own `signerLeaf`, run in this wallet. */
export const liveLeafReader: LeafReader = async (opening) => {
  const account = await import('../../../../contracts/managed/contract/index.js') as unknown as {
    pureCircuits: { signerLeaf(pk: Uint8Array, blinding: Uint8Array, scope: Uint8Array): Uint8Array };
  };
  const leaf = account.pureCircuits.signerLeaf(hexBytes(opening.publicKey), hexBytes(opening.blinding), hexBytes(opening.scope));
  return Array.from(leaf, (b) => b.toString(16).padStart(2, '0')).join('');
};
