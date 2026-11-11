/**
 * **WHICH SERVICE THE COMPANY'S CALLS GO THROUGH, KEPT AS ONE OF THE COMPANY'S OWN RECORDS.**
 *
 * A company chooses one of three: our service, which pays each call's fee and relays it; a service the company
 * hosts itself at an address it names; or none, every call then sent straight to the chain from the signer's own
 * wallet. The choice is one record of the company's `policy` kind, under one id, sealed to the signers and signed
 * by the seat that filed each version, exactly as a vault's spending policy is: the store and the record anchor
 * keep it like every other company record and read nothing in it.
 *
 * **ONE SEAT CANNOT MOVE EVERY OTHER SEAT'S CALLS.** A version is only a seat asking. A choice is in force once
 * as many different seats as a policy change needs have each filed it, unchanged, one version after another
 * (`serviceInForce`); a version that asks for something else starts a new count and leaves the choice in force
 * where it was. The reader hands in only versions filed by seats it believes seated now, so a seat that has left
 * no longer counts; a choice it helped agree that the seats left behind no longer agree is unread, not ours, until a
 * seated signer files it again. Until a choice has been agreed, calls go through our service, as they did before
 * any company chose; a record the reader cannot read whole is not read as ours (the wallet's `companyServiceHere`).
 *
 * **EVERY SIGNER HOLDING THE COMPANY'S KEY OPENS EVERY VERSION.** Each version's key is wrapped to each seat believed
 * seated when it was filed, and once more, under `COMPANY_WRAP_ID`, to a key derived from the company's key at the
 * epoch it was sealed under. A seat seated after a version was filed opens it with that company key, so nobody files
 * anything again for it. A version filed before that copy existed opens only for the seats it was wrapped to. Each
 * version is filed from a signer's own wallet (`chooseCompanyServiceAction`).
 *
 * Pure: the page, the wallet and the service all import it.
 */
import { canonical, fromHex, parseCanonical, seal, unseal, unwrapKey, wrapKey, newSymmetricKey, type Hex } from '../core/crypto.js';
import { keyForThePurpose, type RecordsKey } from '../core/sealed-records.js';
import { recordsKeypairFrom } from './company-nonce-secret.js';
import { paddedToABucket, type PoolSigner, type WrappedPoolKey } from './vault-pool.js';
import type { SealedCompanyRecord } from './sealed-record-wire.js';

/** The company record the choice is kept in: one record of the company's `policy` kind. */
export const COMPANY_SERVICE_RECORD = Object.freeze({ kind: 'policy' as const, id: 'company-service' });

/**
 * The id the copy of a version's key for the company's key is kept under, beside each seat's copy. No seat is named by
 * it: seat ids are their leaves, written in hex, and sealing and opening both refuse a seat that uses it.
 */
export const COMPANY_WRAP_ID = '$company';

/** The pair the company's copy of a version's key is wrapped to: derived from the company's key `key` for this record alone. */
const companyWrapping = (key: RecordsKey, company: string) => recordsKeypairFrom(fromHex(keyForThePurpose(key, company, 'company-service')));

/** What a company chose: our service, its own service at an address, or none. */
export type CompanyService =
  | { readonly service: 'ours' }
  | { readonly service: 'own'; readonly at: string }
  | { readonly service: 'none' };

export const OUR_SERVICE: CompanyService = Object.freeze({ service: 'ours' as const });

/** The longest address a company's own service may be named by. */
const MOST_ADDRESS = 255;

/**
 * Why `value` cannot be the address of a company's own service, or null when it can: a secure web origin alone,
 * with no path, query, fragment or sign-in in it, so nothing the company names can carry anything of a call's
 * own in its address, and named by a site's name, never by a number or as this device, so a choice cannot make
 * every seat's device post into its own machine or network.
 */
export function serviceAddressRefusal(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'no address was named for the company\'s own service';
  if (value.length > MOST_ADDRESS) return `the address of the company's own service is longer than ${MOST_ADDRESS} characters`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `"${value}" is not a web address`;
  }
  if (url.protocol !== 'https:') return `"${value}" is not a secure (https) address`;
  if (url.username !== '' || url.password !== '') return `"${value}" carries a sign-in, and the address of a service carries none`;
  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (host.startsWith('[') || /^[0-9.]+$/u.test(host) || host === 'localhost' || host.endsWith('.localhost')) {
    return `"${value}" is named by a number or as this device, and a company's own service is named by its site's name`;
  }
  if (url.origin !== value) return `"${value}" is more than a site's address: name the site alone, as ${url.origin}`;
  return null;
}

/** The choice `value` says, or null when it says no choice a company can make. */
export const companyServiceOf = (value: unknown): CompanyService | null => {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if ((v.service === 'ours' || v.service === 'none') && keys === 'service') return Object.freeze({ service: v.service });
  if (v.service === 'own' && keys === 'at,service' && serviceAddressRefusal(v.at) === null) {
    return Object.freeze({ service: 'own' as const, at: v.at as string });
  }
  return null;
};

/** Refused before anything was sealed or read from it. */
export class CompanyServiceRefused extends Error {
  constructor(why: string, options?: { cause?: unknown }) {
    super(`${why}. Nothing was filed or read from it.`, options);
    this.name = 'CompanyServiceRefused';
  }
}

interface ServiceLabel {
  readonly record: typeof COMPANY_SERVICE_RECORD.kind;
  readonly id: string;
  readonly company: string;
  readonly version: number;
}
const LABEL = '$label';

/**
 * One version of the record: the choice, sealed under a key made for it and wrapped to each signer named and once to
 * the company's key `sealing` names at its epoch, with the company, record and version sealed inside it so it does not
 * open as another. Signing it is the filer's.
 */
export const sealCompanyService = (input: {
  readonly company: string;
  readonly version: number;
  /** The company's key to seal under now, and its epoch. */
  readonly sealing: { readonly key: Hex; readonly epoch: number };
  readonly choice: CompanyService;
  readonly signers: readonly PoolSigner[];
}): SealedCompanyRecord => {
  const choice = companyServiceOf(input.choice);
  if (choice === null) {
    const at = (input.choice as { at?: unknown } | null)?.at;
    throw new CompanyServiceRefused(serviceAddressRefusal(at) ?? 'that is not our service, the company\'s own or none');
  }
  if (input.signers.length === 0) throw new CompanyServiceRefused('a choice sealed to nobody could never be opened again');
  if (input.signers.some((s) => s.id === COMPANY_WRAP_ID)) throw new CompanyServiceRefused(NOT_A_SEAT);
  const key = newSymmetricKey();
  const label: ServiceLabel = { record: COMPANY_SERVICE_RECORD.kind, id: COMPANY_SERVICE_RECORD.id, company: input.company, version: input.version };
  return {
    company: input.company, kind: COMPANY_SERVICE_RECORD.kind, id: COMPANY_SERVICE_RECORD.id, version: input.version, keyEpoch: input.sealing.epoch,
    sealed: seal(paddedToABucket(canonical({ ...choice, [LABEL]: label })), key),
    wrapped: [
      ...input.signers.map((s) => ({ signerId: s.id, wrapped: wrapKey(key, s.wrappingPublicKey) })),
      { signerId: COMPANY_WRAP_ID, wrapped: wrapKey(key, companyWrapping(input.sealing.key, input.company).publicKey) },
    ],
  };
};

const NOT_A_SEAT = `no seat is named ${COMPANY_WRAP_ID}: that id is kept for the company's key`;

/**
 * The seat a version is opened for, how its own copy of the version's key is opened, and how the company's copy is
 * opened with the company's key at the epoch the version was sealed under. The secrets that open a copy stay with the
 * caller that holds them; this record is handed the opened key and nothing more.
 */
export interface ServiceOpener {
  readonly signerId: string;
  readonly keyOf: (wrapped: WrappedPoolKey['wrapped']) => Hex;
  readonly companyCopy: (epoch: number, wrapped: WrappedPoolKey['wrapped']) => Hex;
}

/**
 * Opens the company's copy of a version's key with the company's key at `epoch`, as `keyAt` gives it on the device
 * that holds it (throwing for an epoch it holds no key for), for the company `company`.
 */
export const openedWithTheCompanyKey = (company: string, keyAt: (epoch: number) => Hex): ServiceOpener['companyCopy'] =>
  (epoch, wrapped) => unwrapKey(wrapped, companyWrapping(keyAt(epoch), company).secret) as Hex;

/** The choice one version holds, opened for the seat `me`; throws `CompanyServiceRefused` when it does not open as this record. */
export const openCompanyService = (rec: SealedCompanyRecord, me: ServiceOpener): CompanyService => {
  if (rec.kind !== COMPANY_SERVICE_RECORD.kind || rec.id !== COMPANY_SERVICE_RECORD.id) throw new CompanyServiceRefused('this record is not the company\'s choice of service');
  if (me.signerId === COMPANY_WRAP_ID) throw new CompanyServiceRefused(NOT_A_SEAT);
  const companys = rec.wrapped.filter((w) => w.signerId === COMPANY_WRAP_ID);
  if (companys.length > 1) throw new CompanyServiceRefused(`version ${rec.version} of the company's choice of service carries more than one copy for the company's key`);
  const mine = rec.wrapped.find((w) => w.signerId === me.signerId);
  const copies: (() => Hex)[] = [
    ...(mine === undefined ? [] : [() => me.keyOf(mine.wrapped)]),
    ...(companys.length === 0 ? [] : [() => me.companyCopy(rec.keyEpoch, companys[0]!.wrapped)]),
  ];
  if (copies.length === 0) throw new CompanyServiceRefused(`version ${rec.version} of the company's choice of service was not sealed to this seat`);
  let body: Record<string, unknown> | undefined;
  let failed: unknown;
  for (const copy of copies) {
    try {
      body = parseCanonical<Record<string, unknown>>(unseal(rec.sealed, copy()));
      break;
    } catch (e) {
      failed = e;
    }
  }
  if (body === undefined) {
    throw new CompanyServiceRefused(mine === undefined
      ? `version ${rec.version} of the company's choice of service was not sealed to this seat, and the company's key at epoch ${rec.keyEpoch} does not open it here`
      : `version ${rec.version} of the company's choice of service would not open with this seat's key`, { cause: failed });
  }
  const label = body?.[LABEL] as Partial<ServiceLabel> | undefined;
  if (label?.record !== rec.kind || label.id !== rec.id || label.company !== rec.company || label.version !== rec.version) {
    throw new CompanyServiceRefused(`version ${rec.version} of the company's choice of service says it is another record or version`);
  }
  const { [LABEL]: _label, ...rest } = body;
  const choice = companyServiceOf(rest);
  if (choice === null) throw new CompanyServiceRefused(`version ${rec.version} of the company's choice of service names no choice a company can make`);
  return choice;
};

/** One version as this device read it: who filed it, if a seat it believes did, and what it asks. */
export interface ServiceVersion {
  readonly version: number;
  /** The signing key of the seat that filed it, or null when this device does not believe a seat did. */
  readonly filer: string | null;
  readonly choice: CompanyService;
}

/** The choice in force and why, or our service and why no other choice is. */
export interface ServiceInForce {
  readonly choice: CompanyService;
  /** Set when no choice is in force, so calls go through our service: says why. */
  readonly unchosen?: string;
}

/**
 * The choice in force: the newest one that `needed` different believed seats filed, unchanged, one version after
 * another. A version asking something else starts a new count; a seat filing the same choice twice counts once.
 */
export function serviceInForce(versions: readonly ServiceVersion[], needed: number): ServiceInForce {
  const bar = Math.max(1, Math.floor(needed));
  let agreed: CompanyService | null = null;
  let asked: string | null = null;
  let by = new Set<string>();
  for (const v of [...versions].sort((a, b) => a.version - b.version)) {
    if (v.filer === null) continue;
    const said = canonical(v.choice);
    if (said !== asked) { asked = said; by = new Set(); }
    by.add(v.filer.toLowerCase());
    if (by.size >= bar) agreed = v.choice;
  }
  if (agreed !== null) return { choice: agreed };
  return {
    choice: OUR_SERVICE,
    unchosen: versions.length === 0
      ? 'the company has not chosen a service, so its calls go through ours'
      : `no choice of service has been filed by the ${bar} seat${bar === 1 ? '' : 's'} a change of policy needs, so the company's calls go through ours`,
  };
}

/** The choice the newest believed versions ask, and how many different seats have filed it, unchanged, one after another. */
export interface ServiceAsked {
  readonly choice: CompanyService;
  readonly by: number;
  /** The number of seats it needs to be in force: as many as a change of policy needs, and at least one. */
  readonly needed: number;
}

/**
 * What the newest believed version asks, counted as `serviceInForce` counts: the seats that filed it, unchanged, in the
 * versions since the last that asked something else. Null when no believed seat filed any version.
 */
export function serviceAsked(versions: readonly ServiceVersion[], needed: number): ServiceAsked | null {
  const bar = Math.max(1, Math.floor(needed));
  let asked: { said: string; choice: CompanyService; by: Set<string> } | null = null;
  for (const v of [...versions].sort((a, b) => a.version - b.version)) {
    if (v.filer === null) continue;
    const said = canonical(v.choice);
    if (asked === null || said !== asked.said) asked = { said, choice: v.choice, by: new Set() };
    asked.by.add(v.filer.toLowerCase());
  }
  return asked === null ? null : { choice: asked.choice, by: asked.by.size, needed: bar };
}
