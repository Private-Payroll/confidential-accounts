/**
 * **A REQUEST SIGNED BY A COMPANY'S SUPER ADMIN, WITH ITS OWN KEY ON THE COMPANY'S COMMITTEE.**
 *
 * A super admin need not hold a seat, so the service cannot know it as a member. It knows it instead by a signature,
 * made in the super admin's own wallet with its committee key, over the company, its account on the chain and the
 * signed-in person the service serves the request to. The signature names no time and no route: it lets that one person in, on the routes of a
 * change of who holds the company's contracts, for as long as the key is on the committee the chain shows, or joining
 * it in a change already kept. Who is on the committee is read from the chain on every request, never from here.
 */
import { joinedBy, superAdminRequestBytes, type SignatureCheck } from 'midnight-identity/profile/committee-sign';
import { canonical } from '../core/crypto.js';

/** The request header a super admin's page carries its signed request in (`superAdminHeaderFor`). */
export const SUPER_ADMIN_HEADER = 'x-super-admin';

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX128 = /^[0-9a-f]{128}$/u;

/** A key on a company's committee, as the chain spells it. */
export interface CommitteeKeyNamed {
  readonly tag: string;
  readonly value: string;
}

/** What a super admin's request carries: its committee key, and its signature over `superAdminRequestBytes`. */
export interface SuperAdminAsks {
  readonly key: CommitteeKeyNamed;
  readonly signature: string;
}

/** The bytes a super admin's wallet signs to be let in for one company and its account, as one signed-in person: the wallet's own definition. */
export { superAdminRequestBytes };

/** The header's value for a signed request: what a super admin's page sends with each request. */
export const superAdminHeaderFor = (asks: SuperAdminAsks): string =>
  canonical({ key: { tag: asks.key.tag.toLowerCase(), value: asks.key.value.toLowerCase() }, signature: asks.signature.toLowerCase() });

/** The signed request a header carries, or null when it carries nothing in that one shape. */
export const superAdminAsksOf = (header: unknown): SuperAdminAsks | null => {
  if (typeof header !== 'string' || header.length > 512) return null;
  let v: unknown;
  try { v = JSON.parse(header); } catch { return null; /* a header that is not JSON carries no request, and is refused as one */ }
  const o = v as { key?: { tag?: unknown; value?: unknown }; signature?: unknown } | null;
  if (typeof o !== 'object' || o === null || typeof o.key !== 'object' || o.key === null) return null;
  const { tag, value } = o.key;
  if (tag !== 'schnorr' || typeof value !== 'string' || !HEX64.test(value) || typeof o.signature !== 'string' || !HEX128.test(o.signature)) return null;
  return { key: { tag, value }, signature: o.signature };
};

/** Whether the request's signature is its key's own, over this company, its account and this signed-in person. */
export const signedBySuperAdmin = (L: SignatureCheck, company: string, userId: string, account: string, asks: SuperAdminAsks): boolean =>
  joinedBy(L, superAdminRequestBytes(company, userId, account), asks.key, asks.signature);
