/**
 * **SEATS IN A COMPANY'S DIRECTORY, AND THE CHAIN'S READ OF WHO HOLDS THEM,
 * FOR TESTS THAT DRIVE THE SERVER'S RELAYS.** The server relays a call a
 * device proved only for the signed-in person's own seat: an entry their
 * wallet signed in the company's directory, for a seat the chain holds (check
 * S). A test files each person's entry, under the key their device files with,
 * before the server starts, and hands the server the chain's read through
 * `directoryChain`. The read is a stand-in, and a test that uses it says so.
 */
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry } from 'midnight-identity/profile/records-key';
import { signingPublicKeyOf, type Hex } from '../core/crypto.js';
import type { SealedAccount } from '../core/types.js';
import type { DirectoryFiling } from '../midnight/seat-directory.js';

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
     * from `n`, naming the key `signingSecret` files with, and has the chain hold
     * that seat from now on. Returns the seat.
     */
    claim(store: DirectoryStore, account: string, person: string, signingSecret: string, n: number): string {
      const rec = store.getAccount(account)!;
      const identity = identityFromSecret(new Uint8Array(32).fill(n));
      const committeeKey = committeeKeyFor(identity, rec.companyLabel as never) as { tag: string; value: string };
      const seat = n.toString(16).padStart(2, '0').repeat(32);
      const statement = signDirectoryEntry(identity, rec.companyLabel as never, rec.contractAddress as never,
        new Uint8Array(32).fill((n + 100) % 256), signingPublicKeyOf(signingSecret as Hex), seat);
      const h = holding.get(account) ?? { committee: [], seats: [] };
      if (!store.fileDirectory(account, { company: account, version: h.seats.length + 1, change: { kind: 'claim', entry: { person, committeeKey, statement } } })) {
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
      return h === undefined ? null : { seats: { committee: [...h.committee], threshold: 1, seats: seats.filter((x) => h.seats.includes(x)) }, approvals: 1 };
    },
  };
};
