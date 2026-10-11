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
import { aCompanysRecords } from './record-tree-double.js';

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
  /*
   * The company's records: what each seat files is entered here by that seat, and every read folds it, after the
   * first batch the first seat anchored with the roster in it, founding the company on the test's chain.
   */
  /* The first seat's own committee key, which held the account from its deploy on that seat's device. */
  const foundingCommittee = committeeKeyFor(identityFromSecret(new Uint8Array(32).fill(seats[0]!.n)), rec0.companyLabel as never) as { tag: string; value: string };
  const records = aCompanysRecords(accountId, {
    seat: held[0]!, signingSecret: seats[0]!.signingSecret as Hex, records: [roster], committee: [foundingCommittee],
  });
  return {
    records,
    /** The company as the service serves it to a page: its account record, and its roster record beside it. */
    served: (): SealedAccount & { roster: SealedCompanyRecord } => ({ ...store.getAccount(accountId)!, roster }),
    roster,
    seats: held,
    /** The directory as filed, and the stand-in for the chain's read: the account holds every seat claimed. */
    reads: {
      anchored: records.anchored,
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
