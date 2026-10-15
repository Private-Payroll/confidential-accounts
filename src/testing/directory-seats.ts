/**
 * **SEATS IN A COMPANY'S DIRECTORY, AND THE CHAIN'S READ OF WHO HOLDS THEM,
 * FOR TESTS THAT DRIVE THE SERVER'S RELAYS.** The server relays a call a
 * device proved only for the signed-in person's own seat: an entry their
 * wallet signed in the company's directory, for a seat the chain holds (check
 * S). A test files each person's entry, under the key their device files with,
 * before the server starts, and hands the server the chain's read through
 * `directoryChain`. The read is a stand-in, and a test that uses it says so.
 *
 * **EVERY SEAT IS MADE AS A DEVICE MAKES ONE** (`seatOpenedFor`): its blinding
 * the hash of its wallet key under a salt, its seat the leaf the account's own
 * compiled `signerLeaf` makes of its opening, and its entry carrying that
 * opening and its wallet key sealed under the company's roster key
 * (`directoryEntryMade`). The salt and public key are drawn from `n` so a
 * test's seats are the same on every run.
 */
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry } from 'midnight-identity/profile/records-key';
import { sha256 } from '@noble/hashes/sha2.js';
import { signingPublicKeyOf, toHex, utf8, type Hex } from '../core/crypto.js';
import type { SealedAccount } from '../core/types.js';
import { directoryEntryMade, type DirectoryFiling } from '../midnight/seat-directory.js';
import { seatBlinding, type LeafOf, type SeatOpening, type WalletKey } from '../core/seat-opening.js';
import { MidnightCommitments } from '../midnight/commitments.js';

/** A company's viewing key in a test whose device never opens its directory: the server never opens an entry's proof. */
export const A_TEST_VIEWING_KEY = toHex(sha256(utf8('a test company\'s viewing key'))) as Hex;

/** The leaf the account's own compiled `signerLeaf` makes of an opening: what a device's vault worker checks against. */
export const leafOfTheContract: LeafOf = (o) => MidnightCommitments.signerLeaf(o.publicKey as Hex, o.blinding as Hex, o.scope as Hex).toLowerCase();

/** A device's vault worker's answer for a set of openings, made with the compiled `signerLeaf`. */
export const leavesOfTheContract = async (openings: readonly SeatOpening[]): Promise<readonly (string | null)[]> => openings.map(leafOfTheContract);

/**
 * **A SEAT MADE FOR `walletKey`, AS A SEATING DEVICE MAKES ONE**: a salt and a
 * public key drawn from `n`, the blinding `seatBlinding` makes of the key under
 * that salt, every vault as its scope, and the seat the leaf of that opening.
 */
export const seatOpenedFor = (walletKey: WalletKey, n: number): { readonly seat: string; readonly opening: SeatOpening } => {
  const key = { tag: 'schnorr', value: walletKey.value.toLowerCase() };
  const salt = toHex(sha256(utf8(`a test seat's salt:${n}:${key.value}`)));
  const opening: SeatOpening = {
    publicKey: toHex(sha256(utf8(`a test seat's public key:${n}`))), scope: MidnightCommitments.allVaults().toLowerCase(),
    blinding: seatBlinding(key, salt), walletKey: key, salt,
  };
  return { seat: leafOfTheContract(opening)!, opening };
};

interface DirectoryStore {
  getAccount(accountId: string): SealedAccount | null;
  fileDirectory(accountId: string, filing: DirectoryFiling): boolean;
}

/** Who holds each company's account, as the chain answers the server: one entry per seat claimed. */
export const directorySeats = () => {
  const holding = new Map<string, { committee: Array<{ tag: string; value: string }>; seats: string[] }>();
  return {
    /**
     * Files `person`'s entry in `account`'s directory, signed by a wallet made
     * from `n`, naming the key `signingSecret` files with, its proof sealed
     * under `viewingKey`, and has the chain hold that seat from now on.
     * Returns the seat.
     */
    claim(store: DirectoryStore, account: string, person: string, signingSecret: string, n: number, viewingKey: Hex = A_TEST_VIEWING_KEY): string {
      const rec = store.getAccount(account)!;
      const identity = identityFromSecret(new Uint8Array(32).fill(n));
      const committeeKey = committeeKeyFor(identity, rec.companyLabel as never) as { tag: string; value: string };
      const { seat, opening } = seatOpenedFor(committeeKey, n);
      const statement = signDirectoryEntry(identity, rec.companyLabel as never, rec.contractAddress as never,
        new Uint8Array(32).fill((n + 100) % 256), signingPublicKeyOf(signingSecret as Hex), seat);
      const h = holding.get(account) ?? { committee: [], seats: [] };
      if (!store.fileDirectory(account, {
        company: account, version: h.seats.length + 1,
        change: { kind: 'claim', entry: directoryEntryMade({ company: account, person, committeeKey, signed: statement, opening, signingSecret: signingSecret as Hex, viewingKey }) },
      })) {
        throw new Error(`the directory of ${account} did not take ${person}'s entry`);
      }
      h.committee.push(committeeKey);
      h.seats.push(seat);
      holding.set(account, h);
      return seat;
    },
    /** The chain's read, as `handInWiring` takes it. */
    directoryChain: async (accountId: string, seats: readonly string[]) => {
      const h = holding.get(accountId);
      return h === undefined ? null : {
        seats: { committee: [...h.committee], threshold: 1, seats: seats.filter((x) => h.seats.includes(x)) }, approvals: 1,
      };
    },
  };
};
