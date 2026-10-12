/**
 * **WHOSE ANCHOR EACH IS: EVERY SEAT'S OPENING OF ITS OWN LEAF, FILED BY THE
 * SEAT'S OWN DEVICE AND READ BY THE COMPANY'S MEMBERS.**
 *
 * The account writes, beside each head of the company's record anchor, the tag
 * of the seat whose call moved it - a hash of the account, the seat's public
 * key and its blinding. Each seat's device files its own opening (`ownOpeningFiled`)
 * as one of the company's records, sealed under the roster key; a member's
 * device opens every seat's and maps each tag to its seat (`tagSeatsHere`),
 * believing an opening only where the account's own `signerLeaf` over it is
 * that seat's leaf - so an opening is its own proof, whoever serves it, and one
 * the service withholds only leaves that seat's tag unmapped. Nothing here
 * reads the chain or believes the service.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { openSeatOpening, sealSeatOpening, type SeatOpening } from '../../../src/core/seat-opening.js';
import { companyRecordEntry } from '../../../src/midnight/record-manifest.js';
import { companyWirePaths, fromCompanyWire, signCompanyFiling, toCompanyWire, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { RecordsEntered } from './record-entered-here.js';
import type { SignerMaterial } from './private-state.js';
import type { VaultBuilderClient } from './vault-worker-client.js';

type Api = (path: string, init?: RequestInit) => Promise<any>;

/** What reading and filing seats' openings asks of this device. */
export interface SeatOpeningsDoors {
  readonly accountId: string;
  /** The company's account address, as the account's own functions take it. */
  readonly account: string;
  /** The company's viewing key, which opens the roster key every opening is sealed under, and the epoch it is at. */
  readonly viewingKey: Hex;
  readonly keyEpoch: number;
  /** The company's service, over this page's own sign-in. */
  readonly api: Api;
  readonly builder: Pick<VaultBuilderClient, 'seatOpenings'>;
}

/** The newest version of `seat`'s opening the service serves, or null for none. */
const openingServed = async (d: SeatOpeningsDoors, seat: string): Promise<SealedCompanyRecord | null> => {
  const b = await d.api(companyWirePaths.newest(d.accountId, 'opening', seat));
  return b?.filed == null ? null : fromCompanyWire(b.filed, { company: d.accountId, kind: 'opening', id: seat }).sealed;
};

/**
 * **EVERY TAG A SEAT OF THE COMPANY ANCHORS UNDER, AND WHICH SEAT IT IS**, for
 * `seats` (the seats, by their leaves, this device believes): each seat's
 * opening as the service serves it, opened with the viewing key and believed
 * only where the account's own `signerLeaf` over it is that seat's leaf. A seat
 * whose opening is not served, or does not open its leaf, is left out.
 */
export async function tagSeatsHere(d: SeatOpeningsDoors, seats: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const opened: { seat: string; opening: SeatOpening }[] = [];
  for (const seat of seats.map((x) => x.toLowerCase())) {
    try {
      const rec = await openingServed(d, seat);
      if (rec !== null) opened.push({ seat, opening: openSeatOpening(rec, d.viewingKey) });
    } catch { /* not served, or not one: that seat's tag is left unmapped */ }
  }
  if (opened.length === 0) return new Map();
  const { openings } = await d.builder.seatOpenings({ account: d.account, openings: opened.map((o) => o.opening) });
  const out = new Map<string, string>();
  opened.forEach((o, i) => {
    const a = openings[i];
    if (a?.leaf != null && a.tag != null && a.leaf.toLowerCase() === o.seat) out.set(a.tag.toLowerCase(), o.seat);
  });
  return out;
}

/**
 * **THIS SEAT'S OWN OPENING, FILED FOR THE COMPANY'S MEMBERS, WHERE IT IS NOT
 * ALREADY**: its public key on the account, scope and blinding, sealed under
 * the roster key and signed by its filing key, filed under its own seat and
 * entered in the company's records. Its seat is the leaf its material makes;
 * the service files it only for the seat whose key signed it. True when filed
 * now; false when the service already serves one that opens this seat's leaf.
 */
export async function ownOpeningFiled(
  d: SeatOpeningsDoors & { readonly material: SignerMaterial; readonly entered: RecordsEntered },
): Promise<boolean> {
  const { own } = await d.builder.seatOpenings({ account: d.account, openings: [], own: d.material });
  if (own === undefined) throw new Error('this device could not work out its own seat\'s opening. Nothing was filed. Reload the page');
  const seat = own.leaf.toLowerCase();
  const served = await openingServed(d, seat).catch(() => null);
  if (served !== null && (await tagSeatsHere(d, [seat])).size > 0) return false;
  const opening: SeatOpening = { publicKey: own.publicKey.toLowerCase() as Hex, scope: String(d.material.scope).toLowerCase() as Hex, blinding: d.material.blinding.toLowerCase() as Hex };
  const signed = signCompanyFiling(sealSeatOpening(d.accountId, seat, opening, (served?.version ?? 0) + 1, d.keyEpoch, d.viewingKey), d.material.signingSecret as Hex);
  await d.api(companyWirePaths.one(d.accountId, 'opening', seat, signed.version), { method: 'PUT', body: JSON.stringify(toCompanyWire(signed)) });
  await d.entered.enter([companyRecordEntry(signed)]);
  return true;
}
