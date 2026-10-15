/**
 * **WHOSE ANCHOR EACH IS: EVERY SEAT'S OPENING OF ITS OWN LEAF, AS THE
 * COMPANY'S MEMBERS BELIEVE IT.**
 *
 * The account writes, beside each head of the company's record anchor, the tag
 * of the seat whose call moved it - a hash of the account, the seat's public
 * key and its blinding. Each seat's opening travels in one place only: its own
 * entry in the company's directory, sealed under the roster key
 * (`sealSeatProof`). A member's device, which opened every entry it believes,
 * maps each tag to its seat from the directory it believes (`tagSeatsHere`),
 * keeping an opening only where the account's own `signerLeaf` over it is that
 * seat's leaf. Nothing here reads the chain or believes the service.
 */
import type { SeatOpening } from '../../../src/core/seat-opening.js';
import type { VaultBuilderClient } from './vault-worker-client.js';

/** What mapping the tags asks of this device: the company's account and the page's vault worker. */
interface TagSeatsDoors {
  /** The company's account address, as the account's own functions take it. */
  readonly account: string;
  readonly builder: Pick<VaultBuilderClient, 'seatOpenings'>;
}

/**
 * **EVERY TAG A SEAT OF THE COMPANY ANCHORS UNDER, AND WHICH SEAT IT IS**, for
 * the seats of the directory this device believes (`seats`, each with the
 * opening this device opened from its entry) that the account holds now
 * (`held`): each opening believed only where the account's own `signerLeaf`
 * over it is that seat's leaf. A seat with no opening here is left out.
 */
export async function tagSeatsHere(
  d: TagSeatsDoors, seats: readonly { readonly seat: string; readonly opening?: SeatOpening }[], held: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const now = new Set(held.map((x) => x.toLowerCase()));
  const opened = seats.flatMap((x) => (x.opening !== undefined && now.has(x.seat.toLowerCase())
    ? [{ seat: x.seat.toLowerCase(), opening: x.opening }] : []));
  if (opened.length === 0) return new Map();
  const { openings } = await d.builder.seatOpenings({ account: d.account, openings: opened.map((o) => o.opening) });
  const out = new Map<string, string>();
  opened.forEach((o, i) => {
    const a = openings[i];
    if (a?.leaf != null && a.tag != null && a.leaf.toLowerCase() === o.seat) out.set(a.tag.toLowerCase(), o.seat);
  });
  return out;
}
