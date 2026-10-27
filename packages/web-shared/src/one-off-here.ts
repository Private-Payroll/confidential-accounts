/**
 * A ONE-OFF PAYMENT'S RECORD, READ ON A SIGNER'S DEVICE.
 *
 * The record (`one-off-record.ts`) is filed from the raising seat's device in
 * the wallet (`fileOneOffHere`, `one-off-raised-here.ts`). Any signer's device
 * reads it back here: its filer is judged as the directory judges every
 * filing, and as the key in force at the batch that anchored it, here as well
 * as in the store, and the device opens it with the company's key, which every
 * signer holds, one seated after it was filed too. From the records it reads,
 * it rebuilds each one-off's tree (`oneOffsHere`), for payroll's checks and a
 * vault's period totals to count beside their own, the one-off a `transfer`
 * proposal raises (`oneOffMadeHere`), for an approval to be made again from,
 * and that one-off alone, by the name its proposal gives (`oneOffRaisedByHere`),
 * for it to be charged and paid. A one-off is filed once and never changes, so
 * a device keeps what it opened by the company and the record's name, and
 * judges what it kept again against the company's records on every read: only
 * a record it has not opened before is fetched and opened. A one-off naming a
 * vendor entry is refused for raising, approving and paying unless it pays the
 * entry's own address and keys (`refuseAOneOffToAnotherVendorHere`); it is
 * counted in every total and check of what the company paid whatever it names.
 * Nothing here signs or files anything.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { parseCanonical, toHex, unseal, utf8, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { keyOf, type KeysHeld } from '../../../src/core/company-key.js';
import { openRecord } from '../../../src/core/sealed-records.js';
import { TRANSFER } from '../../../src/core/proposal-filing.js';
import { payeeKeysRefusal } from '../../../src/core/payee-keys.js';
import type { AssetRegistry } from '../../../src/core/assets.js';
import type { SealedProposal } from '../../../src/core/types.js';
import type { buildOneOffRun, DetailsOfKind, PaidTree } from '../../../src/midnight/payout-tree.js';
import { oneOffEntryOf, oneOffSecretsOf, type OneOffSecrets } from '../../../src/midnight/run-keys.js';
import { verifiedCompanyFiler, type CompanyRecordKind, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { openOneOff, OneOffOpened } from '../../../src/midnight/one-off-record.js';
import { ONE_OFF_KIND, ONE_OFF_VERSION, OneOffRefused } from '../../../src/midnight/one-off-kind.js';
import { companyRecordEntry } from '../../../src/midnight/record-manifest.js';
import { companyRecordKey } from '../../../src/midnight/seat-directory.js';
import { judgeIn, kindAsked, namedHere, type DirectoryRead } from './vault-page-doors.js';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';
import type { OneOffMadeHere } from './what-this-device-made.js';
import type { VendorsHere } from './vendors-on-device.js';

export { OneOffRefused };

/** The company's records a one-off is read from and filed in: judged reads of one version, filings, and the newest version as served, unjudged. */
export interface OneOffRecords {
  at(kind: CompanyRecordKind, id: string, version: number): Promise<SealedCompanyRecord | null>;
  put(rec: SealedCompanyRecord): Promise<void>;
  /** The newest version as the service holds it, not yet judged: what a filing that was not entered is resumed from. */
  served(kind: CompanyRecordKind, id: string): Promise<SealedCompanyRecord | null>;
}

/** What reading a one-off needs of this device: the company, its directory, its records, and the company's keys it holds. */
export interface OneOffReadDoors {
  readonly accountId: string;
  readonly directory: DirectoryRead;
  readonly records: Pick<OneOffRecords, 'at'>;
  /** The company's keys this device holds, every epoch it reaches. */
  readonly keys: KeysHeld;
  readonly registry?: AssetRegistry;
  /** Opens the record (`openOneOff`), passed in by whoever reads: see `OneOffsHere.open`. */
  readonly open: typeof openOneOff;
}

/** A one-off as this device reads it. */
type OneOffRead =
  | { readonly state: 'read'; readonly oneOff: OneOffOpened; readonly version: number; readonly filedBy: Hex | null }
  | { readonly state: 'none' }
  | { readonly state: 'unread'; readonly why: string };

const said = (e: unknown): string => String((e as Error)?.message ?? e).replace(/\.\s*$/u, '');

/** The record served under `id` at the one version a one-off is filed as, if it is this company's one-off of that name. */
async function fetchedHere(
  records: Pick<OneOffRecords, 'at'>, accountId: string, id: string,
): Promise<{ readonly rec: SealedCompanyRecord } | { readonly state: 'none' } | { readonly state: 'unread'; readonly why: string }> {
  let rec: SealedCompanyRecord | null;
  try {
    rec = await records.at(ONE_OFF_KIND, id, ONE_OFF_VERSION);
  } catch (e) {
    return { state: 'unread', why: said(e) };
  }
  if (rec === null) return { state: 'none' };
  if (rec.company !== accountId || rec.kind !== ONE_OFF_KIND || rec.id !== id || rec.version !== ONE_OFF_VERSION) {
    return { state: 'unread', why: 'the record served under this name is another company\'s, another record, or another version than a one-off is filed as, so it is not believed. Reload the page. If it happens again, do not approve it' };
  }
  return { rec };
}

/** Why the company's records, as `judge` reads them, do not believe `rec`'s filer, or null when they do. */
const judgedHere = (judge: ReturnType<typeof judgeIn>, rec: SealedCompanyRecord): string | null =>
  judge(verifiedCompanyFiler(rec), ONE_OFF_KIND, companyRecordKey(ONE_OFF_KIND, rec.id), companyRecordEntry(rec), false, rec.keyEpoch);

const NOT_BELIEVED = (why: string) => `this device does not believe the company's record of this one-off payment: ${why}`;

/** `rec` opened with the company's key at its epoch. */
const openedHere = (doors: Pick<OneOffReadDoors, 'keys' | 'open' | 'registry'>, rec: SealedCompanyRecord): OneOffRead => {
  try {
    return { state: 'read', oneOff: doors.open(rec, keyOf(doors.keys, rec.keyEpoch), doors.registry), version: rec.version, filedBy: verifiedCompanyFiler(rec) };
  } catch (e) {
    return { state: 'unread', why: said(e) };
  }
};

/**
 * **A ONE-OFF PAYMENT, AS THIS DEVICE READS IT**: this company's record under
 * the name asked, at the one version a one-off is filed as (`ONE_OFF_VERSION`:
 * a later version anyone puts over it is never read), its filer believed as the directory judges every filing and
 * the key in force at the batch that anchored it (`judgeIn`, judged here
 * whatever store served it), and opened with the company's key at its epoch.
 */
export async function oneOffHere(doors: OneOffReadDoors, id: string): Promise<OneOffRead> {
  const got = await fetchedHere(doors.records, doors.accountId, id);
  if (!('rec' in got)) return got;
  const why = judgedHere(judgeIn(await doors.directory({ records: [{ store: 'company', kind: ONE_OFF_KIND, id }] })), got.rec);
  if (why !== null) return { state: 'unread', why: NOT_BELIEVED(why) };
  return openedHere(doors, got.rec);
}

/**
 * **WHAT A DEVICE READS ONE-OFF PAYMENTS WITH**, beside the company's other
 * records: the store's reads, the company's keys this device holds, and the
 * vault's own derivation of a payment's details, so each one-off's tree is
 * rebuilt here.
 */
export interface OneOffsHere {
  readonly at: (kind: CompanyRecordKind, id: string, version: number) => Promise<SealedCompanyRecord | null>;
  readonly keys: KeysHeld;
  readonly detailsOf: DetailsOfKind;
  readonly registry?: AssetRegistry;
  /*
   * Opening a record decodes the payee's address, and rebuilding its tree runs the contract's own circuits: code
   * only a wallet's or a device's own build loads, never the page's. So whoever builds this door hands them in
   * (`openOneOff`, `buildOneOffRun`), and a page with no door reads no one-off payment.
   */
  readonly open: typeof openOneOff;
  readonly treeOf: typeof buildOneOffRun;
  /** Where this device keeps the one-offs it opened (`oneOffsKeptHere`); the one this device's code shares when absent. */
  readonly kept?: OneOffsKept;
}

/** A one-off payment this device believes, with what it is rebuilt to on the chain: its secrets and its one-leaf tree. */
export interface OneOffBelieved {
  readonly id: string;
  readonly version: number;
  readonly oneOff: OneOffOpened;
  readonly filedBy: Hex | null;
  readonly secrets: OneOffSecrets;
  readonly tree: PaidTree;
}

/** One one-off as this device opened it: the record, a mark of the key it opened with, and what it was rebuilt to. */
interface KeptOneOff {
  readonly rec: SealedCompanyRecord;
  readonly key: string;
  readonly believed: OneOffBelieved;
}

/** The one-offs a device opened, by company and record name. */
type OneOffsKept = Map<string, KeptOneOff>;

/** An empty place to keep opened one-offs in. */
export const oneOffsKeptHere = (): OneOffsKept => new Map();

/* The one-offs this device's code opened. Holds only what any device with the company's key can read again. */
const KEPT_ON_THIS_DEVICE: OneOffsKept = oneOffsKeptHere();

/** A mark of the company's key at `epoch` as this device holds it, or null when it holds none: what a kept one-off was opened with. */
const keyMarkOf = (keys: KeysHeld, epoch: number): string | null => {
  try {
    return toHex(sha256(utf8(keyOf(keys, epoch))));
  } catch {
    return null;
  }
};

/** A one-off as this device rebuilds it: its tree, from its record's seed. */
export const oneOffBuiltHere = (
  oneOff: OneOffOpened, { detailsOf, treeOf }: Pick<OneOffsHere, 'detailsOf' | 'treeOf'>,
): { readonly secrets: OneOffSecrets; readonly tree: PaidTree } => {
  const secrets = oneOffSecretsOf(oneOff.seed);
  return { secrets, tree: treeOf({ payee: oneOff.paidTo, token: oneOff.token, amount: oneOff.amount }, secrets, detailsOf, oneOff.asset) };
};

/**
 * **ONE ONE-OFF, BELIEVED AND REBUILT ON THIS DEVICE**, or why not, judged by
 * `judge`. One kept from an earlier read is taken again only when `judge` still
 * believes the record kept and the device still holds the key it was opened
 * with; otherwise the record is fetched, judged and opened, and kept.
 */
async function believedHere(
  door: OneOffsHere, accountId: string, id: string, judge: ReturnType<typeof judgeIn>,
): Promise<{ readonly state: 'read'; readonly believed: OneOffBelieved } | { readonly state: 'none' } | { readonly state: 'unread'; readonly why: string }> {
  const kept = door.kept ?? KEPT_ON_THIS_DEVICE;
  const at = `${accountId}|${id}`;
  const held = kept.get(at);
  if (held !== undefined && judgedHere(judge, held.rec) === null && keyMarkOf(door.keys, held.rec.keyEpoch) === held.key) {
    return { state: 'read', believed: held.believed };
  }
  kept.delete(at);
  const got = await fetchedHere(door, accountId, id);
  if (!('rec' in got)) return got;
  const why = judgedHere(judge, got.rec);
  if (why !== null) return { state: 'unread', why: NOT_BELIEVED(why) };
  const read = openedHere(door, got.rec);
  if (read.state !== 'read') return read;
  const believed: OneOffBelieved = { id, version: read.version, oneOff: read.oneOff, filedBy: read.filedBy, ...oneOffBuiltHere(read.oneOff, door) };
  const key = keyMarkOf(door.keys, got.rec.keyEpoch);
  if (key !== null) kept.set(at, { rec: got.rec, key, believed });
  return { state: 'read', believed };
}

const NO_DOOR = 'This page cannot read the company\'s one-off payments, so it cannot check this proposal. Reload the page to get the current version.';

/**
 * **EVERY ONE-OFF PAYMENT THE COMPANY'S RECORDS NAME, AS THIS DEVICE READS
 * THEM**: each believed and rebuilt, or set aside with why it was not read,
 * all judged against one read of the company's records. A device that cannot
 * read one-off payments at all is refused only when the company's records name
 * one, so a company that has made none is read in full. Every one-off believed
 * is here whatever it pays, so what the company paid is counted in full.
 */
export async function oneOffsHere(
  records: { readonly directory: DirectoryRead; readonly oneOffs?: OneOffsHere }, accountId: string,
): Promise<{ readonly believed: readonly OneOffBelieved[]; readonly unread: ReadonlyArray<{ readonly id: string; readonly why: string }> }> {
  const here = await records.directory(kindAsked('company', ONE_OFF_KIND));
  const ids = namedHere(here, 'company', ONE_OFF_KIND);
  if (ids.length === 0) return { believed: [], unread: [] };
  const door = records.oneOffs;
  if (door === undefined) {
    throw new OneOffRefused('This page cannot read the company\'s one-off payments, and the company has made some, so what its '
      + 'vaults have paid cannot be said here. Reload the page to get the current version.');
  }
  const judge = judgeIn(here);
  const believed: OneOffBelieved[] = [];
  const unread: Array<{ id: string; why: string }> = [];
  for (const id of ids) {
    const read = await believedHere(door, accountId, id, judge);
    if (read.state === 'read') believed.push(read.believed);
    else unread.push({ id, why: read.state === 'none' ? 'the service holds no record under the name the company\'s records give it' : read.why });
  }
  return { believed, unread };
}

/** The one-off `id`, believed on this device against the company's records for that one name, or refused. */
async function oneOffNamedHere(
  records: Pick<CompanyRecordsHere, 'directory' | 'oneOffs'>, accountId: string, id: string,
): Promise<OneOffBelieved> {
  const door = records.oneOffs;
  if (door === undefined) throw new OneOffRefused(NO_DOOR);
  const read = await believedHere(door, accountId, id, judgeIn(await records.directory({ records: [{ store: 'company', kind: ONE_OFF_KIND, id }] })));
  if (read.state === 'none') throw new OneOffRefused('The company\'s records hold no one-off payment by the name this proposal gives. Reload the page. If it happens again, do not approve it.');
  if (read.state === 'unread') throw new OneOffRefused(`This device does not believe the one-off payment this proposal raises: ${read.why.replace(/\.$/u, '')}.`);
  return read.believed;
}

/** The one-off a `transfer` proposal's sealed body names, by its record's id and version, or refused. */
const oneOffNamedIn = (named: unknown): { readonly id: string; readonly version: number } => {
  const n = named as { id?: unknown; version?: unknown } | null | undefined;
  if (n === null || typeof n !== 'object' || typeof n.id !== 'string' || !Number.isSafeInteger(n.version)) {
    throw new OneOffRefused('This proposal does not say which one-off payment it raises.');
  }
  return { id: n.id, version: n.version as number };
};

/**
 * **A ONE-OFF AND ITS PROPOSAL, TIED BOTH WAYS**, or refused with why: the
 * proposal's sealed body names this record by its id and version, the record
 * names this proposal by its name and its identity on the chain, for the vault
 * the proposal is raised for, in the currency its change names, and the seat
 * that filed the record filed the proposal. The one statement of the tie, for
 * an approval and a charge alike.
 */
const refuseAOneOffItsProposalDidNotRaise = (
  read: { readonly id?: string; readonly oneOff: OneOffOpened; readonly version: number; readonly filedBy: Hex | null },
  named: { readonly id: string; readonly version: number },
  proposal: { readonly id: string; readonly chainId: string; readonly filedBy: string | null },
  sealed: { readonly vault: string; readonly asset: string },
): void => {
  const o = read.oneOff;
  if ((read.id !== undefined && read.id !== named.id) || read.version !== named.version) {
    throw new OneOffRefused('This proposal names another one-off payment, or another version of it, than the one filed. Do not approve it. Tell the signer who proposed it.');
  }
  if (o.proposal.id !== proposal.id || o.proposal.chainId !== proposal.chainId.toLowerCase()) {
    throw new OneOffRefused('The one-off payment this proposal names says it is raised by another proposal. Do not approve it. Tell the signer who proposed it.');
  }
  if (o.vault !== sealed.vault.toLowerCase()) throw new OneOffRefused('The one-off payment this proposal names is paid from another vault. Do not approve it. Tell the signer who proposed it.');
  if (o.asset !== sealed.asset.toLowerCase()) throw new OneOffRefused('The one-off payment this proposal names is paid in another currency. Do not approve it. Tell the signer who proposed it.');
  if (proposal.filedBy === null || read.filedBy === null || read.filedBy.toLowerCase() !== proposal.filedBy.toLowerCase()) {
    throw new OneOffRefused('The one-off payment this proposal names was filed by another seat than the one that raised it. Do not approve it. Tell the signer who proposed it.');
  }
};

/**
 * **WHY A ONE-OFF NAMING A VENDOR ENTRY IS NOT PAID TO THAT VENDOR**, or null:
 * the entry is one this device believes and would pay (`readVendorsHere`, read
 * for no month), its record's keys are the keys of the address it names
 * (`payeeKeysRefusal`), and the one-off pays that address, on that network, at
 * those keys. The vendor's standing, dates and terms are not asked: a one-off
 * pays an invoice, which a vendor who has left may still be owed. A one-off
 * naming no vendor entry is paid to the address typed, and is never refused here.
 */
export const oneOffVendorRefusal = (o: Pick<OneOffOpened, 'payee' | 'paidTo'>, vendors: Pick<VendorsHere, 'vendors'>): string | null => {
  const ref = o.payee.ref;
  if (ref === null) return null;
  const v = vendors.vendors.find((x) => x.vendor.id === ref)?.vendor;
  if (v === undefined) return 'the vendor entry it names is not one this device believes and would pay. The vendor may have been removed or not set up yet. Ask a signer to check the vendor\'s entry';
  if (v.address === null) return 'the vendor entry it names holds no address to pay. Ask the vendor to give an address, then propose again';
  const keys = payeeKeysRefusal(v.address);
  if (keys !== null) return `the vendor entry it names is not paid: ${keys}`;
  const a = v.address as unknown as Record<string, unknown>;
  const p = o.paidTo as unknown as Record<string, unknown>;
  const same = (x: unknown, y: unknown) => typeof x === 'string' && typeof y === 'string' && x.toLowerCase() === y.toLowerCase();
  if (!same(a.bech32, o.payee.address.trim()) || a.network !== o.payee.network) return 'it pays another address than the vendor entry it names. Do not approve it. Tell the signer who proposed it, or ask them to propose it again from the vendor\'s entry';
  const held = a.kind === 'shielded' ? ['coinPublicKey', 'encryptionPublicKey'] : ['userAddress'];
  if (a.kind !== p.kind || held.some((k) => !same(a[k], p[k]))) return 'it pays other keys than the vendor entry it names. Do not approve it. Tell the signer who proposed it, or ask them to propose it again from the vendor\'s entry';
  return null;
};

/**
 * Refuses `o` when it names a vendor entry and does not pay that entry's own
 * address and keys (`oneOffVendorRefusal`), read from `records.vendors`; a page
 * that cannot read the company's vendors raises, approves and pays no one-off
 * naming one.
 */
export async function refuseAOneOffToAnotherVendorHere(
  records: Pick<CompanyRecordsHere, 'vendors'>, o: Pick<OneOffOpened, 'payee' | 'paidTo'>,
): Promise<void> {
  if (o.payee.ref === null) return;
  if (records.vendors === undefined) {
    throw new OneOffRefused('This one-off payment names a vendor entry, and this page cannot read the company\'s vendors, so it cannot '
      + 'say the payment goes to them. Reload the page to get the current version.');
  }
  const why = oneOffVendorRefusal(o, await records.vendors());
  if (why !== null) throw new OneOffRefused(`This one-off payment is not made: ${why}.`);
}

/**
 * **THE ONE-OFF PAYMENT A `transfer` PROPOSAL IS RAISED OVER, AS THIS DEVICE
 * READS IT**, for an approval to be made again from (`refuseWhatThisDeviceDidNotMake`):
 * the record the proposal names, by its id and version, believed and opened
 * here; naming this proposal by its name and its identity on the chain; for
 * the vault the proposal is raised for, in the currency its change names;
 * filed by the seat that filed the proposal; paying the vendor entry it names,
 * if it names one. With what the person's own wallet read of the once-mark of
 * its nonce. Anything else is refused with why.
 */
export async function oneOffMadeHere(
  records: Pick<CompanyRecordsHere, 'directory' | 'oneOffs' | 'payments' | 'vendors'>, accountId: string,
  proposal: { readonly id: string; readonly chainId: string; readonly filedBy: string | null },
  sealed: { readonly vault: string; readonly named: unknown; readonly asset: string },
): Promise<OneOffMadeHere> {
  const named = oneOffNamedIn(sealed.named);
  if (records.oneOffs === undefined || records.payments === undefined) throw new OneOffRefused(NO_DOOR);
  const read = await oneOffNamedHere(records, accountId, named.id);
  const o = read.oneOff;
  refuseAOneOffItsProposalDidNotRaise(read, named, proposal, sealed);
  await refuseAOneOffToAnotherVendorHere(records, o);
  const entry = oneOffEntryOf(oneOffSecretsOf(o.seed), records.payments.paidOnceOf);
  let held: readonly string[];
  try {
    held = (await records.payments.read([entry])).held;
  } catch (e) {
    throw new OneOffRefused(`Your wallet could not read from the network whether this one-off payment was already paid (${said(e)}). `
      + 'Try again in a minute.', { cause: e });
  }
  return {
    kind: 'transfer', asset: o.asset, facts: { payee: o.paidTo, token: o.token, amount: o.amount }, seed: o.seed,
    opensAt: o.run.opensAt.toString(), closesAt: o.run.closesAt.toString(), required: o.run.required.toString(),
    wallet: { asked: [entry], held: [...held] },
  };
}

/** What a proposal's sealed body says it raises, when it is a `transfer` proposal of this company's; null when it is not one. */
async function transferNamedHere(
  records: Pick<CompanyRecordsHere, 'proposals'>, accountId: string, viewingKey: KeysHeld, proposalId: string,
): Promise<{ readonly rec: SealedProposal; readonly vault: string; readonly asset: string; readonly named: { readonly id: string; readonly version: number } } | null> {
  if (records.proposals === undefined) {
    throw new OneOffRefused('This page cannot read the company\'s proposals, so it cannot say whether this one is a one-off payment. '
      + 'Reload the page to get the current version.');
  }
  const rec = (await records.proposals()).find((p) => p.id === proposalId && p.accountId === accountId);
  if (rec === undefined) return null;
  let envelope: { kind: string; vault: string; sealedPayload: Sealed };
  let body: { oneOff?: unknown; __change?: { asset?: unknown } };
  try {
    const key = keyOf(viewingKey, rec.keyEpoch);
    envelope = openRecord('proposals', rec.accountId, rec.sealed, key);
    if (envelope.kind !== TRANSFER) return null;
    body = parseCanonical(unseal(envelope.sealedPayload, key));
  } catch (e) {
    throw new OneOffRefused('This device cannot read the company\'s record of this proposal, so it cannot say what it pays.', { cause: e });
  }
  return { rec, vault: envelope.vault, asset: String(body.__change?.asset ?? ''), named: oneOffNamedIn(body.oneOff) };
}

/**
 * **THE ONE-OFF PAYMENT A PROPOSAL RAISES, IF IT RAISES ONE, AMONG `believed`**:
 * read from the proposal's own sealed body as this device opens it, never from
 * a record alone. Null when the proposal is not a `transfer` proposal, so a
 * one-off record naming another kind of proposal - a payroll leg's - is never
 * taken for it; the one-off among `believed` that the body names, tied both
 * ways (`refuseAOneOffItsProposalDidNotRaise`), when it is; refused otherwise.
 * For a device that read every one-off already, as a charge does for its period.
 */
export async function oneOffOfTheProposalHere(
  records: Pick<CompanyRecordsHere, 'proposals'>, accountId: string, viewingKey: KeysHeld, proposalId: string,
  believed: readonly OneOffBelieved[],
): Promise<OneOffBelieved | null> {
  const t = await transferNamedHere(records, accountId, viewingKey, proposalId);
  if (t === null) return null;
  const found = believed.find((o) => o.id === t.named.id);
  if (found === undefined) throw new OneOffRefused('This device does not believe the one-off payment this proposal raises.');
  refuseAOneOffItsProposalDidNotRaise(found, t.named, { id: t.rec.id, chainId: t.rec.chainId, filedBy: t.rec.filedBy?.publicKey ?? null },
    { vault: t.vault, asset: t.asset });
  return found;
}

/**
 * **THE ONE-OFF PAYMENT A PROPOSAL RAISES, READ BY THE NAME ITS PROPOSAL GIVES
 * IT**, as `oneOffOfTheProposalHere` ties it, without reading any other one-off
 * of the company's: for a device that pays or approves that one alone.
 */
export async function oneOffRaisedByHere(
  records: Pick<CompanyRecordsHere, 'directory' | 'oneOffs' | 'proposals'>, accountId: string, viewingKey: KeysHeld, proposalId: string,
): Promise<OneOffBelieved | null> {
  const t = await transferNamedHere(records, accountId, viewingKey, proposalId);
  if (t === null) return null;
  const found = await oneOffNamedHere(records, accountId, t.named.id);
  refuseAOneOffItsProposalDidNotRaise(found, t.named, { id: t.rec.id, chainId: t.rec.chainId, filedBy: t.rec.filedBy?.publicKey ?? null },
    { vault: t.vault, asset: t.asset });
  return found;
}
