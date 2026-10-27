/**
 * **AN ENTRY ON A COMPANY'S VENDOR LIST, AS ONE SIGNED COMPANY RECORD.**
 *
 * A vendor, contractors included, is kept apart from the people on the payroll: a `vendor` record sealed under the
 * company's `vendors` purpose key, with nothing beside the seal, signed by the seat that filed it. It carries payment
 * terms instead of a salary, no classification, the dates it is paid within and the address it is paid at. Every
 * version is a new signed version; the newest is the vendor. The address a vendor is paid at is fixed when they are
 * added: by the address typed, or by the code their own wallet hands over, and a later version moves it only with a
 * new code signed by that same wallet (`vendorVersionsRefusal`).
 *
 * Pure: the server and the page both import it.
 */
import type { JoinCode } from 'midnight-identity/profile/join-code';
import type { AddressClaim } from 'midnight-identity/profile/address-claim';
import { canonical, type Hex } from './crypto.js';
import { openRecord, sealRecord } from './sealed-records.js';
import type { AssetId } from './assets.js';
import { VENDOR_ID } from './invitation.js';
import { datesOfTheRecordRefusal } from './payable-days.js';
import { payeeKeysRefusal } from './payee-keys.js';
import { canonicalPeriod } from './calendar-days.js';
import type { Payee } from '../midnight/payee-address.js';
import type { SealedCompanyRecord } from '../midnight/sealed-record-wire.js';

/** The key a vendor entry is sealed under: the company's vendors key, never the payroll's. */
export const VENDOR_PURPOSE = 'vendors' as const;

/** How a vendor is paid: by one-off payments as they come, or a fixed amount each month on a run over the vendor list. */
export type VendorTerms =
  | { readonly kind: 'one-off' }
  | { readonly kind: 'monthly'; readonly asset: AssetId; readonly amount: bigint };

/** One vendor, as the newest version of their record holds them. */
export interface VendorRecord {
  id: string;
  accountId: string;
  name: string;
  email: string | null;
  /** The network the vendor's address is on. */
  network: string;
  /** The calendar day they are paid from, never converted between timezones. */
  startDate: string;
  /** The calendar day monthly payments stop, when they were added with one. */
  endDate?: string | null;
  terms: VendorTerms;
  /** Pending until there is an address to pay them at; a leaver is paid nothing more. */
  status: 'active' | 'pending' | 'leaver';
  /** The address typed when they were added by address, kept as typed; absent when they were added by link. */
  invitedAddress?: string | null;
  /** Where they are paid: the typed address, or the one their own wallet's code names. */
  address: Payee | null;
  /** The key their payslips are sealed to, from the code their wallet handed over; null until they claim. */
  wrappingPublicKey: Hex | null;
  /** The code their own wallet signed for where they are paid, once they have handed one over. */
  payeeCode?: JoinCode | null;
  /** The claim their wallet signed of an unshielded typed address. */
  addressClaim?: AddressClaim | null;
  handedOverBy: string | null;
  admittedBy: string | null;
  admittedAt: string | null;
  /** The signing key of the seat that filed this version, which every reader checks is its filer. */
  madeBy?: Hex;
  /** When this version was made, as one UTC moment off the filing device's clock, signed with it. */
  madeAt?: string;
}

type VendorSecrets = Omit<VendorRecord, 'id' | 'accountId'>;

/** Why `terms` are not terms a vendor can be paid on, or null. */
export const vendorTermsRefusal = (terms: unknown): string | null => {
  const t = terms as Record<string, unknown> | null;
  if (t === null || typeof t !== 'object') return 'it names no payment terms';
  if (t.kind === 'one-off') return Object.keys(t).length === 1 ? null : 'one-off terms carry no amount: each payment names its own';
  if (t.kind !== 'monthly' || Object.keys(t).sort().join(',') !== 'amount,asset,kind') return 'its payment terms are neither one-off nor a monthly amount in one token';
  if (typeof t.asset !== 'string' || t.asset === '') return 'its monthly terms name no token';
  if (typeof t.amount !== 'bigint' || t.amount <= 0n) return 'its monthly amount is above nothing, in the token\'s smallest unit';
  return null;
};

/** Why a vendor record is not one, or null: a vendor's id, a name, payment terms, its own dates, and no salary or classification. */
export const vendorRecordRefusal = (v: VendorRecord): string | null => {
  const r = v as unknown as Record<string, unknown>;
  if ('baseAmount' in r || 'pay' in r || 'classifications' in r || 'classification' in r) {
    return 'a vendor entry carries no salary and no classification: those are an employee\'s';
  }
  if (typeof v.id !== 'string' || !VENDOR_ID.test(v.id)) return 'it is not named by a vendor entry\'s id';
  if (typeof v.name !== 'string' || v.name.trim() === '') return 'it names no vendor';
  if (!['active', 'pending', 'leaver'].includes(v.status)) return 'it does not say where the vendor stands';
  return vendorTermsRefusal(v.terms) ?? datesOfTheRecordRefusal(v);
};

/** One version of a vendor, sealed under the company's vendors key with nothing in the clear. Unsigned: the filing seat signs it. */
export const sealVendor = (v: VendorRecord, version: number, keyEpoch: number, viewingKey: Hex): SealedCompanyRecord => {
  const { id, accountId, ...secrets } = v;
  return {
    company: accountId, kind: 'vendor', id, version, keyEpoch,
    sealed: sealRecord(VENDOR_PURPOSE, accountId, secrets satisfies VendorSecrets, viewingKey), wrapped: [],
  };
};

/** A vendor record opened under the company's vendors key. Throws on a record of another kind, or one that is not a vendor entry. */
export const openVendor = (rec: SealedCompanyRecord, viewingKey: Hex): VendorRecord => {
  if (rec.kind !== 'vendor') throw new Error(`a ${rec.kind} record is not a vendor, so it is not read as one.`);
  const v: VendorRecord = { id: rec.id, accountId: rec.company, ...openRecord<VendorSecrets>(VENDOR_PURPOSE, rec.company, rec.sealed, viewingKey) };
  const why = vendorRecordRefusal(v);
  if (why !== null) throw new Error(`vendor ${rec.id} is not read: ${why}.`);
  return v;
};

/** What a run over the vendor list pays a vendor for `period`: their monthly amount. Throws for a vendor paid by one-offs. */
export const vendorAmountOnTheRun = (v: Pick<VendorRecord, 'name' | 'terms'>, period: string): bigint => {
  if (v.terms.kind !== 'monthly') throw new Error(`${v.name} is paid by one-off payments, so no run for ${canonicalPeriod(period)} pays them`);
  return v.terms.amount;
};

/**
 * **WHY A VENDOR'S VERSIONS DO NOT KEEP THEIR ADDRESS, OR NULL.** `versions` are every version, oldest first, each
 * believed filed by a seat. Every version names the typed address version 1 named; once a wallet has handed over a
 * code, every later version names that same wallet; once an address is set, a version that names another one
 * must carry a new code, which the payable check holds to that wallet's signature (`whyVendorNotPayable`); and every
 * version pays exactly the keys its address names (`payeeKeysRefusal`).
 */
export const vendorVersionsRefusal = (versions: readonly VendorRecord[]): string | null => {
  const first = versions[0];
  if (first === undefined) return 'no version of them was read';
  const typed = first.invitedAddress ?? null;
  for (const [i, v] of versions.entries()) {
    const keys = payeeKeysRefusal(v.address);
    if (keys !== null) return `version ${i + 1} of their entry: ${keys}`;
  }
  for (let i = 1; i < versions.length; i += 1) {
    const before = versions[i - 1]!;
    const now = versions[i]!;
    if ((now.invitedAddress ?? null) !== typed) return `version ${i + 1} of their entry does not name the address it was first filed with`;
    if (before.handedOverBy !== null && now.handedOverBy !== before.handedOverBy) {
      return `version ${i + 1} of their entry names another wallet than the wallet that first handed their address over`;
    }
    const moved = before.address !== null && now.address?.bech32 !== before.address.bech32;
    if (moved && canonical(now.payeeCode ?? null) === canonical(before.payeeCode ?? null)) {
      return `version ${i + 1} of their entry pays another address without a new code from their own wallet`;
    }
  }
  return null;
};
