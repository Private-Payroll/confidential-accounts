import { admitToNonceSecret, openNonceSecrets, recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import type { DeviceRecords, DeviceSigner } from './deposit-on-device.js';
import { readersIn, seatNotBelievedHere, type DirectoryRead } from './vault-page-doors.js';

/**
 * **EACH VAULT'S NONCE SECRET GIVEN TO THE SEATS THAT LACK IT, FROM A SIGNER'S
 * OWN DEVICE.** Every vault named is opened here with this signer's records
 * key, and when any seat named lacks a copy, ONE next version is filed wrapped
 * to everybody who could open it and to every such seat too
 * (`admitToNonceSecret`): nothing about the secret changes. Each copy is sealed
 * to the records key the seat's own directory entry names, and only to a seat
 * among the readers of a vault's secret (`readersIn`: believed, not retired,
 * and held by the account now), whatever its role. A seat named that is not
 * one of them is given nothing and is returned in `skipped` with why
 * (`seatNotBelievedHere`), and the others are still given theirs. A vault every
 * seat named can already open is left as it is.
 */
export async function giveEachVaultSecretHere(input: {
  /** Each vault by the id its nonce secret is filed under. */
  readonly vaultIds: readonly string[];
  readonly me: DeviceSigner;
  /** The seats being given their copies, as the chain names them. */
  readonly seats: readonly string[];
  readonly directory: DirectoryRead;
  readonly records: DeviceRecords;
}): Promise<{
  readonly given: readonly string[]; readonly had: readonly string[];
  readonly skipped: readonly { readonly seat: string; readonly why: string }[];
}> {
  const here = await input.directory();
  const readers = new Map((await readersIn(async () => here).signers()).map((r) => [r.id, r.wrappingPublicKey]));
  const keys: string[] = [];
  const skipped: { seat: string; why: string }[] = [];
  for (const seat of new Set(input.seats.map((s) => s.toLowerCase()))) {
    const key = readers.get(seat);
    if (key !== undefined) { keys.push(key); continue; }
    const entry = here.dir.seats.find((x) => x.seat === seat);
    skipped.push({ seat, why: entry === undefined ? NO_ENTRY : `their seat is not one this device believes: ${seatNotBelievedHere(here, entry)}` });
  }
  const store = input.records('nonce-secret');
  const opener = recordsKeypairFrom(input.me.companyKey);
  const given: string[] = [];
  const had: string[] = [];
  for (const vault of input.vaultIds) {
    const rec = await store.get(vault);
    if (rec === null) throw new Error(`vault ${vault} has no nonce secret filed, so there is no copy to give. Nothing more was filed.`);
    const holding = openNonceSecrets(rec, vault, opener).readers;
    const lacking = keys.filter((k) => !holding.includes(k));
    if (lacking.length === 0) { had.push(vault); continue; }
    await store.put(vault, admitToNonceSecret(rec, vault, opener, lacking.map((publicKey) => ({ publicKey }))));
    given.push(vault);
  }
  return { given, had, skipped };
}

const NO_ENTRY = 'they have no entry in the company\'s directory that this device believes yet, so there is no key of theirs to '
  + 'give a copy to. Their entry is filed from their own device once they are seated';
