/*
 * THE COMPANY'S CHOICE OF SERVICE, READ BY ONE FUNCTION FOR THE WALLET AND THE PAGE. Each version filed is judged
 * against the company's directory as this device believes it, opened with this seat's key or the company's key, and
 * counted only while its filer is seated; a choice that cannot be read whole is said as unread, never taken as ours.
 */
import { canonical, unwrapKey, type Hex } from '../../../src/core/crypto.js';
import { companyWirePaths, fromCompanyWire, verifiedCompanyFiler, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import {
  COMPANY_SERVICE_RECORD, openCompanyService, openedWithTheCompanyKey, serviceInForce, type CompanyService, type ServiceInForce,
  type ServiceOpener, type ServiceVersion,
} from '../../../src/midnight/company-service-record.js';
import { companyRecordKey } from '../../../src/midnight/seat-directory.js';
import { companyRecordEntry, recordKeyOf } from '../../../src/midnight/record-manifest.js';
import type { CompanyKeyHere } from './company-key-here.js';
import type { companyJudges } from './company-judges.js';
import { filingRefusalCodeOf, judgeIn, seatNotBelievedHere, type DirectoryHere } from './vault-page-doors.js';

type DirectoryHereFor = ReturnType<typeof companyJudges>['directoryHereFor'];

/** What a read of the company's choice of service is handed: the wallet's company reach, or the page's own doors. */
export interface ServiceReach {
  readonly accountId: string;
  readonly api: (path: string, init?: RequestInit) => Promise<unknown>;
  readonly judges: { readonly directoryHereFor: DirectoryHereFor };
  readonly label: Parameters<DirectoryHereFor>[1];
  readonly account: Parameters<DirectoryHereFor>[2];
  readonly companyKeys: CompanyKeyHere;
  readonly roster: Parameters<DirectoryHereFor>[4];
  readonly opener: ServiceOpener;
}

/**
 * How this seat opens a version of the company's choice of service: its own copy with `keyOf`, which the caller makes
 * from the secret it holds, and the company's copy with the company's key at the version's epoch, as this device holds
 * it (`keyAt`, which throws for an epoch it holds no key for). The keys stay with the caller; the record is handed only
 * the opened copy.
 */
export const serviceOpenerFor = (
  accountId: string, signerId: string, keyOf: ServiceOpener['keyOf'], companyKeys: Pick<CompanyKeyHere, 'keyAt'>,
): ServiceOpener => ({
  signerId, keyOf, companyCopy: openedWithTheCompanyKey(accountId, (epoch) => companyKeys.keyAt(epoch)),
});

/**
 * The opener of a page that holds the device's signer for the company (`deviceSignerFrom`, made from the company's key and
 * not a seat's own secret): its own copy is opened with that signer's wrapping key, here and nowhere else on the page.
 */
export const serviceOpenerOfSigner = (
  accountId: string, me: { readonly signerId: string; readonly wrappingSecret: Hex }, companyKeys: Pick<CompanyKeyHere, 'keyAt'>,
): ServiceOpener => serviceOpenerFor(accountId, me.signerId, (wrapped) => unwrapKey(wrapped, me.wrappingSecret) as Hex, companyKeys);

/** The company's choice of service as read, or why it could not be read whole. */
export type ServiceRead = ServiceInForce | { readonly unread: string };

const whyOf = (e: unknown): string => String((e as Error)?.message ?? e).replace(/\s*Nothing was [a-z ]+\.?/giu, '').replace(/\.\s*$/u, '');

/**
 * The versions of the company's choice of service this seat counts, read as `companyServiceHere` reads them, for
 * an act that files the next version: it seals and counts from what this returns. Any read that fails is unread.
 */
export async function companyServiceFiledHere(r: ServiceReach): Promise<ServiceFiled | ServiceUnread> {
  const { kind, id } = COMPANY_SERVICE_RECORD;
  try {
    const b = await r.api(companyWirePaths.versions(r.accountId, kind, id)).catch((e: unknown) => {
      if ((e as { status?: unknown } | null)?.status === 404) return null;
      throw e;
    }) as { versions?: unknown } | null;
    const served = Array.isArray(b?.versions)
      ? b!.versions.map((m) => fromCompanyWire(m, { company: r.accountId, kind, id }).sealed) : [];
    const here = await r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster)({ records: [{ store: 'company', kind, id }] }) as DirectoryHere;
    const judge = judgeIn(here);
    const named = versionsNamedIn(here.records);
    return serviceVersionsFrom(served, {
      company: r.accountId, judge, needed: here.holders.policyBar ?? here.holders.approvals, me: r.opener,
      named, withheld: served.length === 0 ? withheldIn(judge, { store: 'company', kind, id }) : null,
      seatedNow: (filer) => {
        const seat = here.dir.seats.find((x) => x.signingKey.toLowerCase() === filer.toLowerCase());
        return seat !== undefined && seatNotBelievedHere(here, seat) === null;
      },
    });
  } catch (e) {
    return { unread: whyOf(e) };
  }
}

/** Why the company's records say the record was withheld; a judge that cannot say is taken as withholding it. */
const withheldIn = (judge: ReturnType<typeof judgeIn>, read: { readonly store: 'company'; readonly kind: string; readonly id: string }): string | null =>
  (judge.withheld === undefined ? 'this wallet cannot tell which versions the company\'s records hold' : judge.withheld(read));

/** Every version of the company's choice of service its anchored records name: those anchored, and those entered since. */
export const versionsNamedIn = (records: Pick<DirectoryHere['records'], 'history' | 'notYetAnchored'>): readonly number[] => {
  const key = recordKeyOf({ store: 'company', ...COMPANY_SERVICE_RECORD });
  return [
    ...(records.history.get(key) ?? []).map((v) => v.version),
    ...records.notYetAnchored.filter((e) => recordKeyOf(e) === key).map((e) => e.version),
  ];
};

/** The versions of the company's choice of service a seat counts, the seats a choice needs, and the highest served. */
export interface ServiceFiled {
  readonly versions: readonly ServiceVersion[];
  readonly needed: number;
  /** The highest version served, believed or not: the next version filed is the one after it. */
  readonly highest: number;
  /** The highest version served when no entry in the company's records names it: not counted, and filed over. */
  readonly unentered?: SealedCompanyRecord;
}

/**
 * The choice could not be read whole. `fileOver` is set when the only reasons are ones a seat resolves by filing the
 * next version: the newest served was never entered, a version this seat cannot open is passed over below the bar,
 * or the choice agreed is no longer agreed by the signers seated now. It holds what this seat counts after them.
 */
export interface ServiceUnread {
  readonly unread: string;
  readonly fileOver?: ServiceFiled;
}

/** What `serviceVersionsFrom` is given beside the versions served. */
interface ServiceReadDoors {
  readonly company: string;
  readonly judge: (filer: Hex | null, kind: 'policy', recordKey: string, read: ReturnType<typeof companyRecordEntry>, newest: boolean, sealedAt?: number) => string | null;
  readonly needed: number;
  readonly me: ServiceOpener;
  /** Every version the company's anchored records name, anchored or entered since. */
  readonly named: readonly number[];
  /** Why the anchored records say a version was withheld, or null. */
  readonly withheld: string | null;
  /** Whether the seat that signs with this key is one this device believes seated now. */
  readonly seatedNow: (filer: Hex) => boolean;
}

/** The choice in force among the versions served (`serviceVersionsFrom`), or why it cannot be read whole. */
export function serviceFromVersions(served: readonly SealedCompanyRecord[], d: ServiceReadDoors): ServiceRead {
  const filed = serviceVersionsFrom(served, d);
  return 'unread' in filed ? { unread: filed.unread } : serviceInForce(filed.versions, filed.needed);
}

const NO_LONGER_AGREED = 'the company\'s choice of service was agreed by signers who are no longer seated, and the signers '
  + 'seated now have not filed it as many times as it needs, so it is not read as ours. A seated signer files the choice again';

/**
 * The versions this seat counts among those served, or why the choice cannot be read whole:
 * - every version the company's anchored records name must be served, and none withheld;
 * - each version is judged before it is opened, the highest served as the newest there is. A version the anchored
 *   records do not name is dropped unopened (never entered, or passed over by the records); the highest refused only
 *   as never entered is not counted and leaves the choice unread until a later version is filed over it. A version
 *   they name refused for any other reason leaves the choice unread, so a service cannot take a filing out of the count.
 *   A version filed by a seat whose role may not file it is passed over at any version; one past its boundary is
 *   passed over only below the highest; one by a seat no longer seated is not counted;
 * - a believed version this seat cannot open (filed in the old form, wrapped to the seats alone, before it was
 *   seated; sealed at an epoch whose company key this device does not hold; or whose copies will not open) is
 *   passed over, with every version before it, only when the versions after it agree a choice by themselves;
 *   otherwise the choice is unread. The choice those later versions agree is the one all of them agree, since a
 *   count only grows with earlier versions and the choice in force is the newest one agreed;
 * - a choice the company agreed that the signers seated now no longer agree, because seats that filed it have
 *   left, is unread, never ours: our service is the answer only for a company whose seats never agreed a choice.
 */
export function serviceVersionsFrom(served: readonly SealedCompanyRecord[], d: ServiceReadDoors): ServiceFiled | ServiceUnread {
  const { kind, id } = COMPANY_SERVICE_RECORD;
  if (d.withheld !== null) return { unread: d.withheld };
  const given = new Set(served.map((rec) => rec.version));
  const named = new Set(d.named);
  const missing = [...named].sort((a, b) => a - b).find((v) => !given.has(v));
  if (missing !== undefined) {
    return { unread: `the company's records name version ${missing} of the company's choice of service, and the service did not give it` };
  }
  const highest = Math.max(0, ...served.map((rec) => rec.version));
  let versions: ServiceVersion[] = [];
  /* The same versions with those of seats no longer seated, to tell a choice once agreed from one never agreed. */
  let all: ServiceVersion[] = [];
  let passedOver: string | null = null;
  let unentered: { readonly rec: SealedCompanyRecord; readonly why: string } | null = null;
  for (const rec of [...served].sort((a, b) => a.version - b.version)) {
    const filer = verifiedCompanyFiler(rec);
    const ours = rec.company === d.company && rec.kind === kind && rec.id === id;
    const refused = ours ? d.judge(filer, kind, companyRecordKey(kind, id), companyRecordEntry(rec), rec.version === highest, rec.keyEpoch) : 'it is filed for another record';
    let left = false;
    if (refused !== null) {
      const code = filingRefusalCodeOf(refused);
      if (rec.version === highest && code === 'not-entered' && !named.has(rec.version)) { unentered = { rec, why: refused }; continue; }
      if (rec.version === highest && code !== 'seat-not-seated' && code !== 'role-may-not-file') return { unread: refused };
      if (!named.has(rec.version) || code === 'past-its-boundary' || code === 'role-may-not-file') continue;
      if (code !== 'seat-not-seated') return { unread: refused };
      left = true;
    }
    if (filer === null) continue;
    left ||= !d.seatedNow(filer);
    let choice: CompanyService;
    try {
      choice = openCompanyService(rec, d.me);
    } catch (e) {
      all = [];
      if (left) continue;
      passedOver = whyOf(e);
      versions = [];
      continue;
    }
    all.push({ version: rec.version, filer, choice });
    if (!left) versions.push({ version: rec.version, filer, choice });
  }
  const filed: ServiceFiled = { versions, needed: d.needed, highest, ...(unentered === null ? {} : { unentered: unentered.rec }) };
  const seated = serviceInForce(versions, d.needed);
  if (passedOver !== null && seated.unchosen !== undefined) return { unread: passedOver, fileOver: filed };
  const once = serviceInForce(all, d.needed);
  if (once.unchosen === undefined && (seated.unchosen !== undefined || canonical(once.choice) !== canonical(seated.choice))) {
    return { unread: NO_LONGER_AGREED, fileOver: filed };
  }
  if (unentered !== null) return { unread: unentered.why, fileOver: filed };
  return filed;
}
