/**
 * **A COMPANY MADE BY THE SERVICE, GIVEN ITS SIGNERS AS A ROSTER RECORD ONE OF
 * ITS SEATS FILED, FOR TESTS THAT READ THE ROSTER ON A DEVICE.** A device reads
 * a company's signers only from its roster record, believed as filed by a seat
 * of its directory. A company the service made keeps its signers on its account
 * record, so a test that makes one that way and reads it on a device files, for
 * each seat it names, an entry its wallet signed, and the roster as that seat's
 * device would file it: each of those signers at the seat their entry names,
 * with the vault keys and records-key statement their wallet signed for it. The chain's read of who holds the account is a
 * stand-in, and a test that uses it says so.
 */
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import { openAccount } from '../core/account.js';
import { signVaultKeys } from '../core/vault-keys.js';
import { signingPublicKeyOf, type Hex } from '../core/crypto.js';
import { sealRoster } from '../core/roster-record.js';
import type { SealedAccount } from '../core/types.js';
import { signCompanyFiling, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import type { DirectoryFiling } from '../midnight/seat-directory.js';
import { directorySeats } from './directory-seats.js';

/** What one device keeps of a company's roster between reads: in memory, for a test's device. */
export interface ADevicesRosterMemory {
  read(): { readonly version: number; readonly digest: string; readonly wallets: Readonly<Record<string, string>> } | null;
  keep(now: { readonly version: number; readonly digest: string; readonly wallets: Readonly<Record<string, string>> }): Promise<void>;
}

/** A device's memory of a company's roster, empty at first, as the keyring keeps it with a person's keys. */
export const aDevicesRosterMemory = (): ADevicesRosterMemory => {
  let kept: ReturnType<ADevicesRosterMemory['read']> = null;
  return { read: () => kept, keep: async (now) => { kept = structuredClone(now); } };
};

interface RosterStore {
  getAccount(accountId: string): SealedAccount | null;
  fileDirectory(accountId: string, filing: DirectoryFiling): boolean;
  directoryFilingsOf(accountId: string): readonly DirectoryFiling[];
}

/**
 * Files `seats`' entries in `accountId`'s directory, each under the signing key
 * its secret makes, and the company's signers as a roster record the first of
 * them filed. Returns the company as a device is served it, and what a device
 * reads to believe it.
 */
export function aRosterASeatFiled(
  store: RosterStore, accountId: string, viewingKey: Hex,
  seats: ReadonlyArray<{ readonly signerId: string; readonly person: string; readonly signingSecret: string; readonly n: number }>,
) {
  const dir = directorySeats();
  const held = seats.map((s) => dir.claim(store, accountId, s.person, s.signingSecret, s.n));
  const rec0 = store.getAccount(accountId)!;
  const opened = openAccount(rec0, viewingKey, null);
  const signers = opened.signers.map((x) => {
    const i = seats.findIndex((s) => s.signerId === x.id);
    if (i < 0) return x;
    const s = seats[i]!;
    const identity = identityFromSecret(new Uint8Array(32).fill(s.n));
    const committeeKey = committeeKeyFor(identity, rec0.companyLabel as never) as { tag: string; value: string };
    const statement = signRecordsKey(identity, rec0.companyLabel as never, rec0.contractAddress as never, new Uint8Array(32).fill((s.n + 100) % 256), held[i]!);
    return {
      ...x, leafCommitment: held[i]! as Hex,
      vaultKeys: signVaultKeys(accountId, x.id, {
        committeeKey, recordsKey: statement.recordsKey as Hex, recordsKeyStatement: statement.signature as Hex, recordsKeySeat: held[i]! as Hex,
      }, s.signingSecret as Hex),
    };
  });
  const roster: SealedCompanyRecord = signCompanyFiling(
    sealRoster(accountId, { name: opened.name, signers }, 1, rec0.keyEpoch, viewingKey),
    seats[0]!.signingSecret as Hex,
  );
  const rec = store.getAccount(accountId)!;
  return {
    /** The company as the service serves it to a page: its account record, and its roster record beside it. */
    served: (): SealedAccount & { roster: SealedCompanyRecord } => ({ ...store.getAccount(accountId)!, roster }),
    roster,
    seats: held,
    /** The directory as filed, and the stand-in for the chain's read: the account holds every seat claimed. */
    reads: {
      believed: aDevicesRosterMemory(),
      filings: async () => store.directoryFilingsOf(accountId),
      holders: async () => {
        const c = (await dir.directoryChain(accountId, held))!;
        return {
          ...c.seats, approvals: c.approvals, adoptedVaults: [], founding: held[0]!,
          foundingCommittee: [c.seats.committee[0]!], account: rec.contractAddress as never,
        };
      },
    },
    filer: signingPublicKeyOf(seats[0]!.signingSecret as Hex),
  };
}
