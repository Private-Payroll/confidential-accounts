/**
 * A ONE-OFF PAYMENT'S RECORD, READ ON A SIGNER'S DEVICE.
 *
 * The record (`one-off-record.ts`) is filed from the raising seat's device in
 * the wallet (`fileOneOffHere`, `one-off-raised-here.ts`). Any signer's device
 * reads it back here: its filer is judged as the directory judges every
 * filing, and as the key in force at the batch that anchored it, here as well
 * as in the store, and the device opens it with the company's key, which every
 * signer holds, one seated after it was filed too. From the records it reads,
 * it rebuilds each one-off's tree (`oneOffsHere`), for payroll's checks to
 * count beside their own, and the one-off a `transfer` proposal raises
 * (`oneOffMadeHere`), for an approval to be made again from. Nothing here
 * signs or files anything.
 */
import { parseCanonical, unseal, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { keyOf, type KeysHeld } from '../../../src/core/company-key.js';
import { openRecord } from '../../../src/core/sealed-records.js';
import { TRANSFER } from '../../../src/core/proposal-filing.js';
import type { AssetRegistry } from '../../../src/core/assets.js';
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

/**
 * **A ONE-OFF PAYMENT, AS THIS DEVICE READS IT**: this company's record under
 * the name asked, at the one version a one-off is filed as (`ONE_OFF_VERSION`:
 * a later version anyone puts over it is never read), its filer believed as the directory judges every filing and
 * the key in force at the batch that anchored it (`judgeIn`, judged here
 * whatever store served it), and opened with the company's key at its epoch.
 */
export async function oneOffHere(doors: OneOffReadDoors, id: string): Promise<OneOffRead> {
  let rec: SealedCompanyRecord | null;
  try {
    rec = await doors.records.at(ONE_OFF_KIND, id, ONE_OFF_VERSION);
  } catch (e) {
    return { state: 'unread', why: said(e) };
  }
  if (rec === null) return { state: 'none' };
  if (rec.company !== doors.accountId || rec.kind !== ONE_OFF_KIND || rec.id !== id || rec.version !== ONE_OFF_VERSION) {
    return { state: 'unread', why: 'the record served under this name is another company\'s, another record, or another version than a one-off is filed as, so it is not believed' };
  }
  const here = await doors.directory({ records: [{ store: 'company', kind: ONE_OFF_KIND, id }] });
  const filedBy = verifiedCompanyFiler(rec);
  const why = judgeIn(here)(filedBy, ONE_OFF_KIND, companyRecordKey(ONE_OFF_KIND, id), companyRecordEntry(rec), false, rec.keyEpoch);
  if (why !== null) return { state: 'unread', why: `this device does not believe the company's record of this one-off payment: ${why}` };
  try {
    return { state: 'read', oneOff: doors.open(rec, keyOf(doors.keys, rec.keyEpoch), doors.registry), version: rec.version, filedBy };
  } catch (e) {
    return { state: 'unread', why: said(e) };
  }
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

/** A one-off as this device rebuilds it: its tree, from its record's seed. */
export const oneOffBuiltHere = (
  oneOff: OneOffOpened, { detailsOf, treeOf }: Pick<OneOffsHere, 'detailsOf' | 'treeOf'>,
): { readonly secrets: OneOffSecrets; readonly tree: PaidTree } => {
  const secrets = oneOffSecretsOf(oneOff.seed);
  return { secrets, tree: treeOf({ payee: oneOff.paidTo, token: oneOff.token, amount: oneOff.amount }, secrets, detailsOf, oneOff.asset) };
};

/**
 * **EVERY ONE-OFF PAYMENT THE COMPANY'S RECORDS NAME, AS THIS DEVICE READS
 * THEM**: each believed and rebuilt, or set aside with why it was not read. A
 * device that cannot read one-off payments at all is refused only when the
 * company's records name one, so a company that has made none is read in full.
 */
export async function oneOffsHere(
  records: { readonly directory: DirectoryRead; readonly oneOffs?: OneOffsHere }, accountId: string,
): Promise<{ readonly believed: readonly OneOffBelieved[]; readonly unread: ReadonlyArray<{ readonly id: string; readonly why: string }> }> {
  const ids = namedHere(await records.directory(kindAsked('company', ONE_OFF_KIND)), 'company', ONE_OFF_KIND);
  if (ids.length === 0) return { believed: [], unread: [] };
  const door = records.oneOffs;
  if (door === undefined) {
    throw new OneOffRefused('This page cannot read the company\'s one-off payments, and the company has made some, so what its '
      + 'vaults have paid cannot be said here. Reload the page to get the current version.');
  }
  const believed: OneOffBelieved[] = [];
  const unread: Array<{ id: string; why: string }> = [];
  for (const id of ids) {
    const read = await oneOffHere({ accountId, directory: records.directory, records: door, keys: door.keys, open: door.open, ...(door.registry === undefined ? {} : { registry: door.registry }) }, id);
    if (read.state === 'read') believed.push({ id, version: read.version, oneOff: read.oneOff, filedBy: read.filedBy, ...oneOffBuiltHere(read.oneOff, door) });
    else unread.push({ id, why: read.state === 'none' ? 'the service holds no record under the name the company\'s records give it' : read.why });
  }
  return { believed, unread };
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
    throw new OneOffRefused('This proposal names another one-off payment, or another version of it, than the one filed.');
  }
  if (o.proposal.id !== proposal.id || o.proposal.chainId !== proposal.chainId.toLowerCase()) {
    throw new OneOffRefused('The one-off payment this proposal names says it is raised by another proposal.');
  }
  if (o.vault !== sealed.vault.toLowerCase()) throw new OneOffRefused('The one-off payment this proposal names is paid from another vault.');
  if (o.asset !== sealed.asset.toLowerCase()) throw new OneOffRefused('The one-off payment this proposal names is paid in another currency.');
  if (proposal.filedBy === null || read.filedBy === null || read.filedBy.toLowerCase() !== proposal.filedBy.toLowerCase()) {
    throw new OneOffRefused('The one-off payment this proposal names was filed by another seat than the one that raised it.');
  }
};

/**
 * **THE ONE-OFF PAYMENT A `transfer` PROPOSAL IS RAISED OVER, AS THIS DEVICE
 * READS IT**, for an approval to be made again from (`refuseWhatThisDeviceDidNotMake`):
 * the record the proposal names, by its id and version, believed and opened
 * here; naming this proposal by its name and its identity on the chain; for
 * the vault the proposal is raised for, in the currency its change names;
 * filed by the seat that filed the proposal. With what the person's own wallet
 * read of the once-mark of its nonce. Anything else is refused with why.
 */
export async function oneOffMadeHere(
  records: Pick<CompanyRecordsHere, 'directory' | 'oneOffs' | 'payments'>, accountId: string,
  proposal: { readonly id: string; readonly chainId: string; readonly filedBy: string | null },
  sealed: { readonly vault: string; readonly named: unknown; readonly asset: string },
): Promise<OneOffMadeHere> {
  const named = oneOffNamedIn(sealed.named);
  const door = records.oneOffs;
  if (door === undefined || records.payments === undefined) {
    throw new OneOffRefused('This page cannot read the company\'s one-off payments, so it cannot check this proposal. Reload the page '
      + 'to get the current version.');
  }
  const read = await oneOffHere({
    accountId, directory: records.directory, records: door, keys: door.keys, open: door.open, ...(door.registry === undefined ? {} : { registry: door.registry }),
  }, named.id);
  if (read.state === 'none') throw new OneOffRefused('The company\'s records hold no one-off payment by the name this proposal gives.');
  if (read.state === 'unread') throw new OneOffRefused(`This device does not believe the one-off payment this proposal raises: ${read.why.replace(/\.$/u, '')}.`);
  const o = read.oneOff;
  refuseAOneOffItsProposalDidNotRaise(read, named, proposal, sealed);
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

/**
 * **THE ONE-OFF PAYMENT A PROPOSAL RAISES, IF IT RAISES ONE**: read from the
 * proposal's own sealed body as this device opens it, never from a record
 * alone. Null when the proposal is not a `transfer` proposal, so a one-off
 * record naming another kind of proposal - a payroll leg's - is never taken for
 * it; the one-off among `believed` that the body names, tied both ways
 * (`refuseAOneOffItsProposalDidNotRaise`), when it is; refused otherwise.
 */
export async function oneOffOfTheProposalHere(
  records: Pick<CompanyRecordsHere, 'proposals'>, accountId: string, viewingKey: KeysHeld, proposalId: string,
  believed: readonly OneOffBelieved[],
): Promise<OneOffBelieved | null> {
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
  const named = oneOffNamedIn(body.oneOff);
  const found = believed.find((o) => o.id === named.id);
  if (found === undefined) throw new OneOffRefused('This device does not believe the one-off payment this proposal raises.');
  refuseAOneOffItsProposalDidNotRaise(found, named, { id: rec.id, chainId: rec.chainId, filedBy: rec.filedBy?.publicKey ?? null },
    { vault: envelope.vault, asset: String(body.__change?.asset ?? '') });
  return found;
}
