/**
 * **WHAT THE VAULT SCREEN HANDS THE VAULT OPERATIONS**, assembled from this
 * page's own session: the company's routes over this page's own sign-in, the
 * company's records over the mounted records route, the roster this device
 * opened, and a place in this browser for a vault's temporary key.
 */
import type { StartedFrom } from './tree-kept-here.js';
import type { Hex } from '../../../src/core/crypto.js';
import { fromHex } from '../../../src/core/crypto.js';
import { whyNotTheCommittee, whyNotTheReaders, type Roster } from './handover-check.js';
import type { Account, SealedProposal, SealedRun } from '../../../src/core/types.js';
import type { WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { PoolSigner } from '../../../src/midnight/vault-pool.js';
import { admitToNonceSecret, openNonceSecrets, recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { HttpSealedPoolStore, pageWireSend, RecordWithheld, type FilingJudge, type FreshJudge } from './http-sealed-pool-store.js';
import {
  believedDirectory, DIRECTORY_REFUSAL, directoryReplayed, FILING_REFUSAL, filingRefusalOf, notOnTheChainNow, seatsWithAnotherRecordsKey,
  type AccountHeld, type DirectoryChange, type DirectoryRefusalCode, type CommitteeKey, type Directory, type DirectoryEntry, type DirectoryFiling, type DirectorySeat, type FiledKind,
} from '../../../src/midnight/seat-directory.js';
import type { AccountHoldersRead, DirectoryEntryStatement, RecordsKeyStatement } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { DeviceRecords, DeviceSigner } from './deposit-on-device.js';
import type {
  DepositInFlight, DepositsInFlight, PaymentInFlight, PaymentsInFlight, TemporaryKeys, VaultService,
} from './vault-operation.js';
import { sealedOnThisDevice, type InFlightOpener, type InFlightRecords, type SealedInFlight } from './in-flight-on-this-device.js';
import type { SigningKeyOnTheWire } from './vault-worker-client.js';
import type { AccountDeployed } from './governed-call-builder.js';
import type { ChargeInFlight, ChargesInFlight } from './run-charged-here.js';
import type { RecordsEntered } from './record-entered-here.js';
import { companyRecordEntry, directoryEntry, proposalEntry, recordKeyOf, runEntry, type RecordRead } from '../../../src/midnight/record-manifest.js';
import { transitionStopSaid, type CheckedHead, type TransitionStop } from '../../../src/midnight/record-tree.js';
import { askedFor, DIRECTORY, heldStandingOf, namedIn, neverEnteredIn, type RecordsAsked, type RecordsHeld } from '../../../src/midnight/records-held.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { ROSTER_ID } from '../../../src/core/roster-record.js';
import { FOUNDING_KEY_EPOCH, stateRecordId } from '../../../src/core/founding-state.js';

type Api = (path: string, init?: RequestInit) => Promise<any>;

/** A refusal from the service keeps the service's own mark of whether anything was sent. */
export const marked = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    throw Object.assign(new Error(message), { nothingWasSent: /Nothing was sent/u.test(message) });
  }
};

/**
 * **THE COMPANY'S VAULT ROUTES, AS THE PAGE CALLS THEM, WITH EVERY COMMITTEE
 * AND EVERY RECORDS KEY THEY REPORT CHECKED AGAINST THE SEALED ROSTER.**
 *
 * `roster` opens the company's roster on this device. A committee the service
 * reports that is not exactly the keys the roster names is refused before a
 * vault is built for it, and a records key the roster does not name is refused
 * before the vault's secret is wrapped to it. A vault the service reads as held
 * by its committee is read as not held when the committee on the chain is not
 * the roster's, so no pool is opened and no money goes in.
 */
export const vaultServiceFor = (api: Api, accountId: string, roster: () => Promise<Roster>): VaultService => {
  const base = `/api/accounts/${encodeURIComponent(accountId)}`;
  const post = (path: string, tx: string) => marked(() => api(path, { method: 'POST', body: JSON.stringify({ tx }) }));
  return {
    keys: async () => {
      const [served, named] = await Promise.all([api(`${base}/vault-keys`), roster()]);
      const refused = (served.committee === null ? null : whyNotTheCommittee(served.committee.committee, named))
        ?? whyNotTheReaders(served.readers ?? [], named, served.committee !== null);
      if (refused !== null) throw new Error(`${refused} Nothing was built or sent.`);
      return served;
    },
    deploy: (tx) => post(`${base}/vaults`, tx),
    handover: (vault, tx) => post(`${base}/vaults/${vault}/handover`, tx),
    chain: async (vault) => {
      const view = await api(`${base}/vaults/${vault}/chain`);
      const heldBy = view.heldByCommittee === true && view.authority ? view.authority.committee : null;
      if (!view.committee && heldBy === null) return view;
      const named = await roster();
      const offered = view.committee ? whyNotTheCommittee(view.committee.committee, named) : null;
      const held = heldBy === null ? null : whyNotTheCommittee(heldBy, named);
      const refused = offered ?? held;
      return refused === null ? view
        : { ...view, committee: null, heldByCommittee: false, fundable: false, why: refused };
    },
    deposit: (vault, tx) => post(`${base}/vaults/${vault}/deposit`, tx),
    depositPublicly: (vault, tx, money) => marked(() => api(`${base}/vaults/${vault}/public-deposit`, {
      method: 'POST', body: JSON.stringify({ tx, token: money.token, amount: money.amount }),
    })),
    payoutState: (vault) => api(`${base}/vaults/${vault}/payout-state`),
    payout: (vault, tx) => post(`${base}/vaults/${vault}/payout`, tx),
    merge: (vault, tx) => post(`${base}/vaults/${vault}/merge`, tx),
    payoutPublicly: (vault, tx) => post(`${base}/vaults/${vault}/public-payout`, tx),
  };
};

/**
 * **THIS DEVICE AS A SIGNER OF THE COMPANY'S VAULTS: ITS SEAT, AND THE RECORDS
 * KEY ITS WALLET GIVES FOR THE COMPANY.** A vault's pool and journals are
 * wrapped to the records key in each signer's own directory entry and filed
 * under their seat, so this device opens its copy with the records key worked
 * out from the company key its wallet released - never with a key the roster
 * names, which the service opens with a key it holds.
 */
export const deviceSignerFrom = (seat: string, companyKey: Hex): DeviceSigner => {
  const key = fromHex(companyKey);
  return { signerId: seat.toLowerCase(), wrappingSecret: recordsKeypairFrom(key).secret, companyKey: key };
};

/**
 * **WHO A VAULT'S POOL AND JOURNALS ARE WRAPPED TO: EVERY SEAT THIS DEVICE
 * BELIEVES NOW**, read afresh for each write - an entry its own wallet signed,
 * for a records key that wallet attested, not retired, its committee key on
 * the account's committee and its seat held - each under its seat, to the
 * records key its entry names. A seat with no entry yet is given no copy; it
 * is wrapped in on the first write after its entry is filed.
 */
export const readersIn = (directory: DirectoryRead) => ({
  signers: async (): Promise<readonly PoolSigner[]> => {
    const here = await directory();
    return here.dir.seats
      .filter((x) => seatNotBelievedHere(here, x) === null)
      .map((x) => ({ id: x.seat, wrappingPublicKey: x.wrappingKey }));
  },
});

/** Every records-key statement the roster this device opened carries, with the committee key that signed it. */
export const attestedIn = (account: Pick<Account, 'signers'>): { committeeKey: CommitteeKey; statement: RecordsKeyStatement }[] =>
  account.signers.flatMap((s) => {
    const k = s.vaultKeys;
    if (!k || !k.recordsKeyStatement || !k.recordsKeySeat) return [];
    return [{
      committeeKey: { tag: k.committeeKey.tag, value: k.committeeKey.value.toLowerCase() },
      statement: { recordsKey: k.recordsKey.toLowerCase(), seat: k.recordsKeySeat.toLowerCase(), signature: k.recordsKeyStatement.toLowerCase() },
    }];
  });

/** The company's seat directory as the server serves it: every filing, in order, for this device to replay. */
export const directoryFilingsFrom = async (api: Api, accountId: string): Promise<readonly DirectoryFiling[]> => {
  const answer = await api(`/api/accounts/${encodeURIComponent(accountId)}/directory`) as { filings?: unknown } | null;
  if (!Array.isArray(answer?.filings)) throw new Error('the company\'s directory could not be read, so no filing is believed.');
  return answer!.filings as DirectoryFiling[];
};

/** What this device reads to believe a company's directory: every filing, its own wallet's read of the chain, and the roster's statements. */
export interface DirectoryHereDeps {
  readonly filings: () => Promise<readonly DirectoryFiling[]>;
  readonly label: CompanyLabel;
  readonly accountId: string;
  /** Who holds the account now and its approval threshold, as the person's own wallet read it for this read. */
  readonly holders: () => Promise<AccountHoldersRead>;
  /** The records-key statements in the roster this device opened. */
  readonly attested: () => Promise<readonly { committeeKey: CommitteeKey; statement: RecordsKeyStatement }[]>;
  /**
   * **THE COMPANY'S RECORDS AS THE HEAD ON CHAIN HOLDS THEM, FOR WHAT THIS READ
   * ASKED** (`recordsHeldHere`), read with the directory just believed: every
   * header since the last head this device checked, checked, up to the head the
   * account's history holds at the indexer the person's own wallet names; the
   * leaves of what was asked, proven against the root it binds; and who held
   * the account as each directory version was anchored (`held`).
   */
  readonly anchored: (directory: DirectoryBelieved, asked: RecordsAsked) => Promise<RecordsHeldHere>;
}

/**
 * Per version of the company's directory: who held the account as the batch
 * that anchored it named them - the approvals it required and the seats its
 * signer tree's leaves name, which that batch's anchor call checked as it ran -
 * with the committee the account's history shows after that call's block;
 * null when it may be anchored and that is not known (past a header this
 * device could not check, or the leaves do not make the root the header
 * names); undefined while it is not yet anchored. What a filing of that
 * version is counted against (`believedDirectory`).
 */
export type HeldAsAnchored = (version: number) => AccountHeld | null | undefined;

/**
 * **THE SEATS THE COMPANY'S FIRST HEADER NAMES**: every leaf but the
 * vacant-slot one that the company's first header names, when those leaves
 * make the signer root its anchor call checked; null when they do not; absent
 * while nothing is anchored or founding was not asked. What the founding seat
 * is read from (`foundingSeatHere`).
 */
interface FirstAnchorSeats {
  readonly firstSeats?: readonly string[] | null;
  /** How the account was deployed, as its history at the indexer the person's own wallet names shows it; null when it does not open with its deploy. */
  readonly deployed?: AccountDeployed | null;
}

/**
 * The company's records as one read holds them, with who held the account as
 * each directory version was anchored, and - when a header on the chain's path
 * could not be checked because the directory it was judged by was not served
 * whole - the first version the service left out or served as other bytes.
 */
export type RecordsHeldHere = RecordsHeld & {
  readonly held?: HeldAsAnchored;
  readonly directoryServed?: { readonly version: number; readonly without: boolean };
  /**
   * Where this device began checking the company's records, when not from its
   * first batch: the head a payroll run's approvers vouched for, the records
   * then checked back to that run's time by them, or the header before the
   * latest for a company one key holds. A state a screen can read.
   */
  readonly checkedFrom?: StartedFrom;
  /**
   * Where a recovery the read went through resumed from, and the last batch
   * this device had checked that the quorum gave up (`recoveredSaid`).
   */
  readonly recovered?: { readonly resumedFrom: CheckedHead; readonly gaveUpTo: number };
} & FirstAnchorSeats;

/** **THE DIRECTORY, AND THE COMPANY'S RECORDS FOR WHAT A READ ASKS, READ AFRESH** (`directoryHere`): the door every reader is given. */
export type DirectoryRead = (asked?: RecordsAsked) => Promise<DirectoryHere>;

/** A company's directory as this device believes it, before the company's records are read with it. */
export type DirectoryBelieved = Omit<DirectoryHere, 'records'>;

/**
 * A company's directory as this device believes it for one read, with the read
 * of the chain it was believed against and the company's records as the head
 * on chain holds them, for what the read asked.
 */
export interface DirectoryHere {
  /** The company's records as the head on chain holds them for this read: what every record read here is believed by. */
  readonly records: RecordsHeld & FirstAnchorSeats & Pick<RecordsHeldHere, 'checkedFrom'>;
  readonly dir: Directory;
  readonly holders: AccountHoldersRead;
  /** The seats whose entry names a wrapping key their own wallet did not attest. */
  readonly another: ReadonlySet<string>;
  /**
   * **THE DIRECTORY AS IT STOOD AT AN EARLIER VERSION**: the filings this read
   * was given up to `version`, replayed by the same rules as `dir`, with each
   * filing's digest as its entry in the company's records names it. Each
   * version anchored is counted against who held the account as it was
   * anchored (`held`, or this read's own once its records are read). Null past
   * the filings given.
   */
  readonly at: (version: number, held?: HeldAsAnchored) => { readonly dir: Directory; readonly digests: readonly Hex[] } | null;
  /**
   * **THE DIRECTORY VERSIONS THE COMPANY'S RECORDS PASSED OVER**, as served:
   * filed, never entered, a later version anchored past each. None of their
   * changes is applied; each is said, with its way out (`passedOverSaid`): a
   * claim among them is filed again as a new version by its own seat's device,
   * and a quorum's change under its own signatures by a device that may anchor.
   */
  readonly passedOver?: readonly DirectoryFiling[];
  /**
   * **EVERY QUORUM'S CHANGE NOT APPLIED**, by the version its signatures were
   * made for, oldest first, with its change: what a device files again
   * (`refiled`) when the replay would believe it filed as the next version.
   */
  readonly notApplied?: readonly KeptChange[];
  /** Each quorum's change filed again and not applied, with why (`refiledRefusalOf`): said by `passedOverSaid`. */
  readonly refiledRefused?: readonly { readonly version: number; readonly signedAt: number; readonly why: DirectoryRefusalCode }[];
  /**
   * **THESE CHANGES FILED AGAIN**, in this order, as the directory's next
   * versions: the filings this read's replay would apply, each as the next
   * version after those before it, and why each other one would not be.
   */
  readonly refiled?: (changes: readonly KeptChange[]) => {
    readonly filed: readonly DirectoryFiling[];
    readonly refused: ReadonlyMap<number, DirectoryRefusalCode>;
    /** The changes held back, by the version each was signed for: the first waits for a seat's own entry to be filed again. */
    readonly waiting: ReadonlySet<number>;
  };
  /** The versions a change filed again was signed for whose filing again is applied and anchored. */
  readonly anchoredAgain?: ReadonlySet<number>;
}

/** A quorum's change, by the version its signatures were made for. */
type KeptChange = { readonly signedAt: number; readonly change: Exclude<DirectoryChange, { kind: 'claim' }> };

/** Said wherever a read meets a header it could not check: nothing past it is believed. */
const pastAStop = (stop: TransitionStop): string =>
  `the company's records cannot be read past a batch this device cannot open: ${transitionStopSaid(stop)}`;

/**
 * **THE DIRECTORY THIS DEVICE BELIEVES, READ AFRESH, WITH THE COMPANY'S RECORDS
 * FOR WHAT THIS READ ASKED.** Replayed against the account this person's own
 * wallet read who holds, and the only one an entry or a statement is believed
 * for. Throws when anything it reads cannot be read, and while the company's
 * records cannot be read past a header this device could not check.
 */
export const directoryHere = async (deps: DirectoryHereDeps, asked: RecordsAsked = {}): Promise<DirectoryHere> => {
  const here = await directoryWithItsRecordsHere(deps, asked);
  /*
   * **NO DIRECTORY IS BELIEVED PAST A HEADER THIS DEVICE COULD NOT CHECK.** It
   * may anchor a version of the directory - a demotion, a retirement - and who
   * held the account as it was anchored cannot be said, so who may act, who is
   * wrapped to and the roster are refused here, as every record read past it is.
   */
  if (here.records.stopped !== null) throw new Error(pastAStop(here.records.stopped));
  return here;
};

/**
 * **THE DIRECTORY AS REPLAYED, WITH THE RECORDS IT WAS REPLAYED WITH, WHETHER
 * OR NOT THEIR CHECK STOPPED.** For the one door that must see a stop to say
 * why: anchoring the company's records, which refuses on it in its own words
 * (`anchorTheRecordsHere`). Every reader acts on `directoryHere`.
 */
export const directoryWithItsRecordsHere = async (deps: DirectoryHereDeps, asked: RecordsAsked = {}): Promise<DirectoryHere> => {
  const [filings, holders, attested] = await Promise.all([deps.filings(), deps.holders(), deps.attested()]);
  const now = { approvals: holders.approvals, seats: holders.seats, committee: holders.committee };
  const believedAs = (asAnchored?: HeldAsAnchored): DirectoryBelieved => {
    const dir: Directory = believedDirectory(deps.accountId, filings, deps.label, holders.account, now, asAnchored);
    const at = (version: number, held: HeldAsAnchored | undefined = asAnchored) => (version < 0 || version > filings.length ? null : {
      dir: believedDirectory(deps.accountId, filings.slice(0, version), deps.label, holders.account, now, held),
      digests: filings.slice(0, version).map((f) => directoryEntry(f).digest),
    });
    return { dir, holders, another: seatsWithAnotherRecordsKey(dir, deps.label, holders.account, attested), at };
  };
  const { held, directoryServed, ...records } = await deps.anchored(believedAs(), asked);
  /* Every version the anchor holds counted against who held the account as it was anchored, never who holds it now. */
  const believed = believedAs(held);
  const replayed = directoryReplayed(deps.accountId, filings, deps.label, holders.account, now, held);
  /*
   * **THE DIRECTORY SERVED IS AT LEAST THE ONE ANCHORED, BYTE FOR BYTE.** A
   * service serving it older than a version the anchor holds, or other bytes at
   * one, would have a seat believed or not on a directory nobody filed.
   */
  const found = [...records.directory].find(([v, d]) => filings[v - 1] === undefined || directoryEntry(filings[v - 1]!).digest !== d.digest);
  const back = found === undefined ? directoryServed
    : { version: found[0], without: filings[found[0] - 1] === undefined };
  if (back !== undefined) {
    throw new Error(`the company's directory was served ${back.without ? 'without' : 'with other bytes at'} `
      + `version ${back.version}, which the company's records anchor on chain, so no seat in it is believed. Reload the page; if it `
      + 'happens again, the service is withholding the company\'s directory');
  }
  const passedOver = neverEnteredIn(records, DIRECTORY).flatMap((v) => (filings[v - 1] === undefined ? [] : [filings[v - 1]!]));
  /* A quorum's change not applied, by the version it was signed for: filed again only as this replay would believe it. */
  const notApplied = new Map<number, Exclude<DirectoryChange, { kind: 'claim' }>>();
  for (const f of filings) {
    const at = f.signedAt ?? f.version;
    if (f.change.kind !== 'claim' && !replayed.replay.applied.has(at) && !notApplied.has(at)) notApplied.set(at, f.change);
  }
  const refiledRefused = filings.flatMap((f) => {
    const why = replayed.refused.get(f.version);
    /* One passed over is said as passed over; this is for one the replay refused on its own merits. */
    return f.signedAt === undefined || why === undefined || replayed.replay.passed.has(f.version) ? [] : [{ version: f.version, signedAt: f.signedAt, why }];
  });
  /* A change resting on a seat whose own entry was passed over: it names that seat, or that seat's key signed it. */
  const passedClaims = passedOver.flatMap((f) => (f.change.kind === 'claim' ? [f.change.entry.statement] : []));
  const restsOnAnEntry = (c: KeptChange) => passedClaims.some((st) => st.seat === c.change.seat
    || (Array.isArray(c.change.signatures) && c.change.signatures.some((x) => x?.publicKey?.toLowerCase() === st.signingKey.toLowerCase())));
  const refiled = (changes: readonly KeptChange[]) => {
    const filed: DirectoryFiling[] = [];
    const refused = new Map<number, DirectoryRefusalCode>();
    const waiting = new Set<number>();
    /* The seats a change waiting for a seat's own entry holds back. */
    const heldBack = new Set<string>();
    for (const c of changes) {
      /*
       * One that waits for a seat's own entry to be filed again holds back every later change to its own seat, so one
       * seat's changes are filed again in their first order once it is: filed past it, the waiting one would undo a later
       * change to its seat. A change to another seat is never held back by it.
       */
      if (heldBack.has(c.change.seat)) { waiting.add(c.signedAt); continue; }
      const f: DirectoryFiling = { company: deps.accountId, version: filings.length + filed.length + 1, change: c.change, signedAt: c.signedAt };
      const why = directoryReplayed(deps.accountId, [...filings, ...filed, f], deps.label, holders.account, now, held).refused.get(f.version);
      if (why === undefined) { filed.push(f); continue; }
      if ((why === 'no-such-seat' || why === 'below-quorum') && restsOnAnEntry(c)) {
        heldBack.add(c.change.seat);
        waiting.add(c.signedAt);
        continue;
      }
      refused.set(c.signedAt, why);
    }
    return { filed, refused, waiting };
  };
  const anchoredAgain = new Set(filings.flatMap((f) => (f.signedAt !== undefined && replayed.replay.applied.has(f.version)
    && records.directory.has(f.version) ? [f.signedAt] : [])));
  return {
    ...believed, records, passedOver, refiledRefused, refiled, anchoredAgain,
    notApplied: [...notApplied].sort(([a], [b]) => a - b).map(([signedAt, change]) => ({ signedAt, change })),
  };
};

/**
 * **WHAT A DIRECTORY VERSION PASSED OVER MEANS, AND THE WAY PAST IT**, or null
 * when none was. Its change is not applied, so the directory may disagree with
 * who holds the account on chain; it is never lost: a seat's own entry is filed
 * again, as a new version, the next time that seat opens the company on its
 * own device, and a change its quorum signed is filed again under the
 * signatures it was made with by a device that may anchor - or, where the
 * replay would not believe it filed again, why not. A change filed again and
 * not applied is said with why.
 */
export const passedOverSaid = (here: Pick<DirectoryHere, 'passedOver' | 'refiledRefused' | 'notApplied' | 'refiled'>): string | null => {
  const over = here.passedOver ?? [];
  const refused = here.refiledRefused ?? [];
  if (over.length === 0 && refused.length === 0) return null;
  const claims = over.filter((f) => f.change.kind === 'claim').map((f) => f.version);
  const signed = [...new Set(over.filter((f) => f.change.kind !== 'claim').map((f) => f.signedAt ?? f.version))];
  /* Whether each change passed over would be believed filed again now, or why not: the replay's own answer. */
  const answer = here.refiled?.(here.notApplied ?? []);
  const wouldNot = answer?.refused ?? new Map<number, DirectoryRefusalCode>();
  /* A change resting on a seat whose own entry was passed over waits for that entry to be filed again, and is filed after it. */
  const waitsForItsEntry = (v: number) => answer?.waiting.has(v) === true;
  const filedAgain = signed.filter((v) => !wouldNot.has(v));
  /* A change passed over once more after it was filed again: what a service withholding it does. */
  const again = filedAgain.filter((v) => over.filter((f) => (f.signedAt ?? f.version) === v).length > 1);
  const passed = over.length === 0 ? [] : [`the company's records passed over version${over.length > 1 ? 's' : ''} `
    + `${over.map((f) => f.version).join(', ')} of its directory - never entered while a later version was anchored - so their changes are not applied`
    + (claims.length > 0 ? `; the seat whose entry version ${claims.join(', ')} holds files it again by opening the company on its own device` : '')
    + (filedAgain.length > 0 ? `; the change signed for version ${filedAgain.join(', ')} is filed again, under the signatures it was `
      + 'made with, by the next device of the company that may anchor as it opens the company'
      + (filedAgain.some(waitsForItsEntry) ? ', once the entry of the seat it rests on is filed again' : '') : '')
    + (again.length > 0 ? `; the change signed for version ${again.join(', ')} was passed over again after it was filed again: if it keeps `
      + 'happening, the service is withholding it from the devices that anchor' : '')];
  const said = (why: DirectoryRefusalCode) => DIRECTORY_REFUSAL[why].replace(/\.$/u, '');
  const not = [
    ...signed.filter((v) => wouldNot.has(v)).map((v) => `the change signed for version ${v} is not filed again: ${said(wouldNot.get(v)!)}`),
    ...refused.map((r) => `version ${r.version}, the change signed for version ${r.signedAt} filed again, is not applied: ${said(r.why)}`),
  ];
  return [...passed, ...not].join('; ');
};

/** Said wherever a company's founding seat is asked for before anything of the company is anchored on chain. */
const NOT_FOUNDED_ON_CHAIN = 'the company\'s founding records are not anchored on chain yet, so its founding seat cannot be '
  + 'said. Its founding signer anchors them by opening the company on their own device';

/** What a read asks to say who founded the company: its first header, and its first state and roster. */
export const FOUNDING_ASKED: RecordsAsked = Object.freeze({ founding: true });

/**
 * **THE FOUNDING SEAT'S ENTRY, AS THIS DEVICE BELIEVES IT**, or why not. The
 * founding seat is read from the company's first header on chain: the one seat
 * it names, its leaves making the signer root its anchor call checked, and the
 * seat that signed it. That batch is anchored by the founding signer's device
 * before a second signer can be seated, so a first header naming more than one
 * seat names no founding seat. Its entry is the one the directory believes for
 * that seat: a claim anchored with the first batch is counted against the
 * committee the account held after that anchor's block, which holds the
 * founding signer's wallet alone, so a claim to that seat signed by any other
 * wallet is never believed, whenever it was filed. The entry is kept whether
 * the seat is held now or not. And the account must have been held by that
 * seat's own wallet alone from its deploy (`heldFromTheStartRefusal`): one held
 * any other way has no founding seat. The one rule for which seat founded the
 * company. Asked of a read made with `FOUNDING_ASKED`.
 */
export const foundingSeatHere = (here: DirectoryHere): DirectorySeat | string => {
  const first = here.records.first;
  if (first === undefined) {
    if (here.records.stopped !== null && here.records.reached.seq < 0) return pastAStop(here.records.stopped);
    return 'this read did not ask who founded the company, so its founding seat is not said. Reload the page';
  }
  if (first === null) return here.records.stopped === null ? NOT_FOUNDED_ON_CHAIN : pastAStop(here.records.stopped);
  const seats = here.records.firstSeats;
  if (seats === undefined || seats === null) {
    return 'the seats the company\'s first anchor names do not make the signer root its anchor call checked, so its founding '
      + 'seat cannot be said. Tell the company\'s other seats';
  }
  if (seats.length !== 1) {
    return `the company's first anchor was made with ${seats.length} seats on its account, so its founding records were not `
      + 'anchored before a second signer was seated and no seat can be said to have founded it. Create the company again';
  }
  const seat = here.dir.seats.find((s) => s.seat === seats[0]!.toLowerCase());
  if (seat === undefined) return 'the seat the company\'s first anchor names has no entry in its directory that this device believes';
  if (seat.signingKey !== first.anchoredBy.publicKey.toLowerCase()) {
    return 'the company\'s first anchor was not made by the one seat its account held then, so no seat can be said to have '
      + 'founded it. Tell the company\'s other seats';
  }
  return heldFromTheStartRefusal(here.records.deployed, seat) ?? seat;
};

/**
 * **WHY THE COMPANY'S ACCOUNT WAS NOT HELD BY ITS FOUNDING SEAT'S OWN WALLET
 * FROM ITS DEPLOY**, or null when it was: deployed seating that one seat alone,
 * held by that seat's own committee key alone at a threshold of one, with no
 * update made yet and no circuit of the second creation step - so the record
 * anchor reached the account only through an update that wallet signed, and
 * no first anchor could be made before it did. A deploy itself is signed by
 * nobody, so this is what the chain can show; that the wallet signs that update
 * only on the device that made the seat is the wallet's to hold. An account
 * held any other way, the one the service makes on its own path included, has
 * no founding seat.
 */
const heldFromTheStartRefusal = (deployed: AccountDeployed | null | undefined, seat: DirectorySeat): string | null => {
  const none = 'the company\'s account was not held by its founding signer\'s own wallet alone from its deploy, so it has no founding '
    + 'seat this device believes. Create the company again from its founding signer\'s device';
  if (deployed === undefined || deployed === null) return none;
  const key = deployed.committee[0];
  const heldByTheSeat = deployed.committee.length === 1 && deployed.threshold === 1 && key !== undefined
    && key.tag.toLowerCase() === seat.committeeKey.tag.toLowerCase() && key.value.toLowerCase() === seat.committeeKey.value.toLowerCase();
  const seatedAlone = deployed.seats.length === 1 && deployed.seats[0]!.toLowerCase() === seat.seat;
  return heldByTheSeat && seatedAlone && deployed.updates === 0 && !deployed.ranSecondStep ? null : none;
};

/**
 * **WHY THIS DEVICE DOES NOT BELIEVE A RECORD THE COMPANY WAS FOUNDED WITH**,
 * or null when it does: the founding seat must be one (`foundingSeatHere`), the
 * record must be what `shape` says it is under that seat's signing key, and the
 * company's first header must hold that very version of it, entered by that
 * seat - the records a company is founded with are anchored in its first batch
 * and in no later one. The one rule for its first state and its first roster.
 */
export const foundingRecordRefusalHere = (
  here: DirectoryHere, rec: SealedCompanyRecord, shape: (foundingSigningKey: string) => string | null,
): string | null => {
  const seat = foundingSeatHere(here);
  if (typeof seat === 'string') return seat;
  const why = shape(seat.signingKey);
  if (why !== null) return why;
  const entry = companyRecordEntry(rec);
  const anchored = (here.records.history.get(recordKeyOf(entry)) ?? []).find((x) => x.version === entry.version);
  if (anchored === undefined || anchored.batch !== 0) {
    return 'the company\'s first anchor does not hold it, so it is not a record the company was founded with';
  }
  if (anchored.digest !== entry.digest) return ANCHOR_REFUSAL['not-the-anchored-bytes'];
  if (anchored.filedBy !== seat.signingKey) return ANCHOR_REFUSAL['not-the-filers-entry'];
  return null;
};

/**
 * **WHETHER THE COMPANY IS FOUNDED ON CHAIN**: its founding seat said, and its
 * first header holding its first state and its first roster, each entered by
 * that seat. Null when it is; why not when it is not. Asked before a second
 * signer is seated, so the founding seat is never one of two.
 */
export const foundedOnChainHere = (here: DirectoryHere): string | null => {
  const seat = foundingSeatHere(here);
  if (typeof seat === 'string') return seat;
  const held = (kind: 'state' | 'roster', id: string) => (here.records.history.get(recordKeyOf({ store: 'company', kind, id })) ?? [])
    .some((x) => x.version === 1 && x.batch === 0 && x.filedBy === seat.signingKey);
  if (!held('state', stateRecordId(FOUNDING_KEY_EPOCH)) || !held('roster', ROSTER_ID)) {
    return 'the company\'s first anchor does not hold its first state and its first roster, entered by its founding seat';
  }
  return null;
};

/**
 * Why a version of a record read as the newest is not known to be the newest
 * the company's records name, or null when it is: a newer version entered,
 * anchored or not, or a header this device could not check, which may hold one.
 */
export const newerNamedRefusal = (here: DirectoryHere, read: RecordRead): string | null => {
  if (here.records.stopped !== null) return pastAStop(here.records.stopped);
  const s = heldStandingOf(here.records, read);
  if (s.standing === 'not-asked') return ANCHOR_REFUSAL['not-asked'];
  return s.newest > (read.version ?? 0) ? ANCHOR_REFUSAL['newer-withheld'] : null;
};

/**
 * **WHY THIS DEVICE DOES NOT BELIEVE A FILING NOT YET ANCHORED**, signed by
 * `filer`, of kind `kind`, counted under `recordKey` at `version`, by the
 * directory it believes now; or null when it does. The rule for what the
 * anchor does not hold yet: the next anchor judges it the same way.
 */
const filingRefusalNow = (
  here: DirectoryBelieved, filer: Hex | null, kind: FiledKind, recordKey: string, version: number,
): string | null => {
  if (filer === null) return 'it carries no valid signature for this record';
  const seat = here.dir.seats.find((x) => x.signingKey === filer.toLowerCase());
  if (seat !== undefined && here.another.has(seat.seat)) {
    return 'it is signed by a seat whose own wallet has not attested the records key its directory entry names';
  }
  const refused = filingRefusalOf(here.dir, here.holders, filer, kind, recordKey, version);
  return refused === null ? null : FILING_REFUSAL[refused];
};

/** Why a record read is not what the head on chain holds, in words a person can act on. */
const ANCHOR_REFUSAL = Object.freeze({
  'older-than-anchored': 'it is an older version than the one the company\'s records anchor on chain, so the service served a '
    + 'stale one. Reload the page; if it happens again, the service is withholding the newest',
  'not-the-anchored-bytes': 'it is not the bytes the company\'s records anchor on chain for that version, so it is not what its '
    + 'seat filed. Reload the page; if it happens again, the service is changing the company\'s records',
  'not-the-filers-entry': 'the company\'s records name it under another seat than the one whose signature it carries, so it is '
    + 'not believed. Tell the company\'s other seats',
  'not-entered': 'no entry in the company\'s records names it, so it was never filed as this company\'s record or its entry '
    + 'was never kept. Whoever filed it files it again from their own device',
  'never-entered': 'the company\'s records passed over this version: its entry was never entered, and a later version of it is '
    + 'anchored on chain, so it is not believed. Read the record again for the version that stands',
  'newer-withheld': 'a newer version of it is in the company\'s records and the service did not give it, so it is not the '
    + 'newest. Reload the page; if it happens again, the service is withholding the newest',
  'not-asked': 'this read did not have it proven against the anchor on chain, so it is not believed. Reload the page; if it '
    + 'happens again, this page does not read that record yet',
} as const);

/**
 * **THE ONE RULE FOR BELIEVING A RECORD READ ON THIS DEVICE.** The record must
 * be one this read asked for, and what the head on chain holds for it
 * (`heldStandingOf`), as the entry its own filer signed: anchored - its leaf
 * proven against the root the head binds, its filer judged by the directory
 * as anchored with it - or newer than its leaf and judged by the directory
 * now. Read as the newest, no newer version may be entered, and every header
 * up to the head on chain must have been checked: one this device could not
 * check may hold a newer version. A record the anchor does not hold is judged
 * by the directory now first, so a filer this device does not believe is said
 * as that. Null when it is believed; the reason when it is not.
 */
const refusalHere = (
  here: DirectoryHere, filer: Hex | null, kind: FiledKind, recordKey: string, read: RecordRead, newest: boolean,
): string | null => {
  if (filer === null) return 'it carries no valid signature for this record';
  const s = heldStandingOf(here.records, read, filer);
  if (s.standing === 'not-asked') return ANCHOR_REFUSAL['not-asked'];
  if (s.standing !== 'anchored') {
    const why = filingRefusalNow(here, filer, kind, recordKey, s.version ?? read.version ?? 1);
    if (why !== null) return why;
  }
  switch (s.standing) {
    case 'anchored':
      /* Read as the newest past a header this device could not check: a newer version may be in it. */
      if (newest && here.records.stopped !== null) return pastAStop(here.records.stopped);
      break;
    case 'not-yet-anchored':
      break;
    case 'past-a-stop':
      return pastAStop(here.records.stopped!);
    case 'older-than-anchored':
      if (s.version === null || newest) return ANCHOR_REFUSAL['older-than-anchored'];
      break;
    default:
      return ANCHOR_REFUSAL[s.standing];
  }
  return newest && s.newest > s.version! ? ANCHOR_REFUSAL['newer-withheld'] : null;
};

/**
 * **WHETHER THIS DEVICE BELIEVES A SEAT NOW, AS A SEAT**: its entry's records
 * key attested by its own wallet, not retired, its committee key on the
 * account's committee and the seat held. The one rule for who a vault's
 * records are wrapped to, who is given a vault's secret, and whose wallet
 * raised an invitation. Null when it does; the reason when it does not.
 */
export const seatNotBelievedHere = (here: DirectoryHere, seat: DirectorySeat): string | null => {
  if (here.another.has(seat.seat)) return 'its own wallet has not attested the records key its directory entry names';
  if (seat.retired !== null) return 'it has retired';
  const off = notOnTheChainNow(seat, here.holders);
  return off === null ? null : FILING_REFUSAL[off].replace(/^it is signed by a seat /u, 'it is a seat ');
};

/**
 * **WHY A RECORD THE SERVICE DID NOT GIVE AT ALL IS NOT READ AS ABSENT**: a
 * version of it is anchored, or entered and not yet anchored, or a header this
 * device could not check may hold one. Null only when the record was asked and
 * its position is proven empty with nothing entered.
 */
const withheldRefusal = (here: DirectoryHere, read: Pick<RecordRead, 'store' | 'kind' | 'id'>): string | null => {
  const s = heldStandingOf(here.records, { ...read, digest: '' as Hex });
  if (s.standing === 'not-asked') return ANCHOR_REFUSAL['not-asked'];
  if (s.newest > 0) {
    return `the company's records name version ${s.newest} of it and the service did not give it. Reload the page; if it `
      + 'happens again, the service is withholding it';
  }
  return here.records.stopped === null ? null : pastAStop(here.records.stopped);
};

/** Who this device believes filed a version, and whether it is what the head on chain holds, for one read; and what was withheld. */
export const judgeIn = (here: DirectoryHere): FilingJudge => Object.assign(
  (filer: Hex | null, kind: FiledKind, recordKey: string, read: RecordRead, newest = false) => refusalHere(here, filer, kind, recordKey, read, newest),
  {
    withheld: (read: Pick<RecordRead, 'store' | 'kind' | 'id'>) => withheldRefusal(here, read),
    neverEntered: (read: Pick<RecordRead, 'store' | 'kind' | 'id'> & { readonly version: number }) =>
      askedFor(here.records, read) && neverEnteredIn(here.records, read).includes(read.version),
  },
);

/**
 * **A LIST THE SERVICE SERVED, REFUSED WHEN IT LEAVES OUT A RECORD THE
 * COMPANY'S RECORDS NAME, OR SERVES ONE AS OTHER BYTES.** Every run or proposal
 * the company's records name - its kind's every leaf proven against the root
 * the head binds, and every entry newer than them - must be in the list the
 * service gives, as the very bytes its newest entry names and filed by the
 * seat that entry's filer is (`judgeIn`, read as the newest): one left out, or
 * served under its id as an older version or as anything else, is withheld,
 * never a record that does not exist or one passed over, so nothing worked out
 * from the list - a period already raised, the rounds still live, what a raise
 * is checked against, the proposal already open for a change - is built on it.
 * A record the company's records do not name is left for its reader to
 * refuse. The list as served when nothing is withheld. The read must have
 * asked for the kind whole (`kindAsked`).
 */
export const listedHere = <T extends ListedRecord>(
  here: DirectoryHere, store: 'run' | 'proposal', listed: readonly T[], what: string,
): readonly T[] => {
  const given = new Set(listed.map((x) => x.id));
  const named = namedHere(here, store, store);
  const missing = named.filter((id) => !given.has(id));
  if (missing.length > 0) {
    const id = missing[0]!;
    const why = withheldRefusal(here, { store, kind: store, id })
      ?? 'the company\'s records name it and the service did not give it. Reload the page; if it happens again, the service is withholding it';
    throw new RecordWithheld(`${what} (${id}${missing.length > 1 ? `, and ${missing.length - 1} more` : ''})`, why);
  }
  const names = new Set(named);
  for (const x of listed) {
    if (!names.has(x.id)) continue;
    const why = otherBytesRefusal(here, store, x);
    if (why !== null) throw new RecordWithheld(`${what} (${x.id})`, `the service gave it as other bytes than the company's records name: ${why}`);
  }
  return listed;
};

/**
 * **WHETHER A LISTED RECORD THE COMPANY'S RECORDS NAME IS SERVED AS THE BYTES
 * ITS NEWEST ENTRY NAMES**, under the key that entry's filer signed with. Bytes
 * only: whether that filer is believed is its reader's to judge, and a record
 * past a header this device could not check is left to its reader too. Null
 * when it is; the reason when it is not.
 */
const otherBytesRefusal = (here: DirectoryHere, store: 'run' | 'proposal', x: ListedRecord): string | null => {
  const filer = typeof x.filedBy?.publicKey === 'string' ? x.filedBy.publicKey.toLowerCase() as Hex : null;
  if (filer === null) return 'it carries no valid signature for this record';
  const entry = store === 'run' ? runEntry(here.dir.company, x as unknown as SealedRun, 1) : proposalEntry(here.dir.company, x as unknown as SealedProposal);
  const s = heldStandingOf(here.records, { store, kind: store, id: x.id, digest: entry.digest, ...(store === 'proposal' ? { version: 1 } : {}) }, filer);
  switch (s.standing) {
    case 'anchored':
    case 'not-yet-anchored':
      return s.newest > s.version! ? ANCHOR_REFUSAL['newer-withheld'] : null;
    case 'past-a-stop':
      return null;
    default:
      return ANCHOR_REFUSAL[s.standing];
  }
};

/** A run or a proposal as the service lists it: its id, and the key its filer signed it with. */
interface ListedRecord { readonly id: string; readonly filedBy?: { readonly publicKey: string } }

/** What a read asks to have one store's records of one kind listed: the kind whole. */
export const kindAsked = (store: RecordRead['store'], kind: string = store): RecordsAsked => ({ kinds: [{ store, kind }] });

/** Every record of one store and kind the company's records name, anchored or entered and not yet anchored, by id; the read must have asked for the kind. */
export const namedHere = (here: DirectoryHere, store: RecordRead['store'], kind: string): readonly string[] =>
  namedIn(here.records, { store, kind });

/**
 * **WHO THIS DEVICE BELIEVES FILED A VERSION, WORKED OUT AFRESH FOR EVERY
 * READ**, for the records and kinds that read names. The directory is read
 * again and replayed here, and the chain is read again by the person's own
 * wallet (`holders`, with no press): a version is believed only when an entry
 * the seat's own wallet signed names its key, the seat is seated now and on the
 * committee, its role may file the record, and its entry's wrapping key is the
 * records key its wallet attested in the roster this device opened, under the
 * key that signed its entry: a seat with no such statement is refused, never
 * skipped. A record the read did not name is refused. Nothing of one read is
 * kept for the next.
 */
export const directoryJudge = (deps: DirectoryHereDeps): FreshJudge => async (asked) => {
  let here: DirectoryHere;
  try {
    here = await directoryHere(deps, asked);
  } catch (e) {
    const why = `who filed it could not be checked (${(e as Error)?.message ?? String(e)})`;
    /* Nothing is believed, and nothing the service leaves out is read as absent: a record not given is refused the same way. */
    return Object.assign(() => why, { withheld: () => why });
  }
  return judgeIn(here);
};

/**
 * **A NEW SIGNER'S COPY OF EACH VAULT'S NONCE SECRET, GIVEN FROM A SIGNER'S
 * OWN DEVICE.** Every vault named is opened here with this signer's records
 * key, and the next version is filed wrapped to everybody who could open it
 * and to the new signer too (`admitToNonceSecret`): nothing about the secret
 * changes. The new signer's copy is sealed to the records key their own
 * directory entry names - the key their wallet signed for the seat the account
 * holds - and to nothing the roster says, so it is given only once this device
 * believes that seat, by the one rule it wraps a vault's records by
 * (`seatNotBelievedHere`), whatever its role: an entry not
 * yet filed, or not believed, gives nothing. A vault whose newest version the
 * new signer can already open is left as it is.
 */
export async function giveEachVaultSecretHere(input: {
  /** Each vault by the id its nonce secret is filed under. */
  readonly vaultIds: readonly string[];
  readonly me: DeviceSigner;
  /** The seat being given its copies. */
  readonly seat: string;
  readonly directory: DirectoryRead;
  readonly records: DeviceRecords;
}): Promise<{ readonly given: readonly string[]; readonly had: readonly string[] }> {
  const here = await input.directory();
  const entry = here.dir.seats.find((x) => x.seat === input.seat.toLowerCase());
  if (entry === undefined) {
    throw new Error('the new signer has no entry in the company\'s directory that this device believes yet, so there is no '
      + 'key of theirs to give a copy to. Nothing was filed. Their entry is filed from their own device once they are seated.');
  }
  const store = input.records('nonce-secret');
  const opener = recordsKeypairFrom(input.me.companyKey);
  const given: string[] = [];
  const had: string[] = [];
  const why = seatNotBelievedHere(here, entry);
  if (why !== null) throw new Error(`the new signer is not given a copy, because their seat is not one this device believes: ${why}. Nothing was filed.`);
  for (const vault of input.vaultIds) {
    const rec = await store.get(vault);
    if (rec === null) throw new Error(`vault ${vault} has no nonce secret filed, so there is no copy to give. Nothing more was filed.`);
    if (openNonceSecrets(rec, vault, opener).readers.includes(entry.wrappingKey)) { had.push(vault); continue; }
    await store.put(vault, admitToNonceSecret(rec, vault, opener, [{ publicKey: entry.wrappingKey }]));
    given.push(vault);
  }
  return { given, had };
}

export const deviceRecordsFor = (
  signingSecret: Hex, judge: FreshJudge, signedInAs: () => string | null, entered: RecordsEntered,
): DeviceRecords => {
  const send = pageWireSend(signedInAs);
  return (record: WireRecord) => new HttpSealedPoolStore(record, send, signingSecret, judge, entered);
};

/**
 * **THIS SIGNER'S OWN ENTRY IN THE COMPANY'S SEAT DIRECTORY, FILED FROM THIS
 * DEVICE** with the statement their wallet signed in the same press as their
 * records key. Filed as the next version; an entry already there for this seat
 * with these keys is left alone, so it can run on every press.
 */
const fileOwnDirectoryEntry = async (
  api: Api, accountId: string, person: string, label: CompanyLabel,
  signed: { readonly committeeKey: CommitteeKey; readonly entry: DirectoryEntryStatement },
): Promise<'filed' | 'already-there'> => {
  const filings = await directoryFilingsFrom(api, accountId);
  /* The account this person's own wallet signed the entry for. */
  const dir = believedDirectory(accountId, filings, label, signed.entry.account as AccountAddress);
  const mine = dir.seats.find((x) => x.seat === signed.entry.seat);
  if (mine !== undefined && mine.signingKey === signed.entry.signingKey && mine.wrappingKey === signed.entry.wrappingKey) {
    return 'already-there';
  }
  const entry: DirectoryEntry = { person, committeeKey: { ...signed.committeeKey }, statement: { ...signed.entry } };
  const filing: DirectoryFiling = { company: accountId, version: filings.length + 1, change: { kind: 'claim', entry } };
  await fileDirectoryFiling(api, accountId, filing);
  return 'filed';
};

/**
 * One filing of the company `accountId`'s seat directory, handed to the service
 * at the version it names. The service keeps it only as the next version,
 * signed by a seat that may file it; nothing here is believed until the
 * directory is read again and replayed.
 */
export const fileDirectoryFiling = async (api: Api, accountId: string, filing: DirectoryFiling): Promise<void> => {
  await api(`/api/accounts/${encodeURIComponent(accountId)}/directory/${filing.version}`, { method: 'PUT', body: JSON.stringify(filing) });
};

/** A directory entry this signer's own wallet signed, kept on their device until the company's directory holds it. */
export interface OwedDirectoryEntry {
  /** The signed-in person the entry names: only they may file it. */
  readonly person: string;
  readonly company: CompanyLabel;
  readonly signed: { readonly committeeKey: CommitteeKey; readonly entry: DirectoryEntryStatement };
}

/** What became of an owed entry: filed now, found already there, nothing owed, or not yet taken, and why. */
export type OwedEntryFiled = 'filed' | 'already-there' | 'nothing-owed' | { readonly notYet: string };

/**
 * **A SIGNER'S DIRECTORY ENTRY, FILED FROM THEIR OWN DEVICE AS SOON AS THE
 * DIRECTORY WILL TAKE IT.** The entry is signed by their wallet in the press
 * that gives their vault keys at seating; it is believed only while the
 * account's committee lists the wallet that signed it and the account holds
 * the seat, which may be later. So it is kept (`owed`) and filed again on
 * every way into the company until the directory holds it, and let go then.
 * A refusal is not an error here: it leaves the entry owed, and says why.
 */
export const fileTheOwedDirectoryEntry = async (
  api: Api, accountId: string,
  owed: { read(): OwedDirectoryEntry | null; settle(): Promise<void> },
): Promise<OwedEntryFiled> => {
  const now = owed.read();
  if (now === null) return 'nothing-owed';
  let done: 'filed' | 'already-there';
  try {
    done = await fileOwnDirectoryEntry(api, accountId, now.person, now.company, now.signed);
  } catch (e) {
    return { notYet: (e as Error)?.message ?? String(e) };
  }
  await owed.settle();
  return done;
};

/**
 * **A VAULT'S TEMPORARY KEY, KEPT IN THIS BROWSER UNTIL ITS HANDOVER HAS LANDED.**
 * It is written before the deploy is sent, so an answer lost on the way does
 * not lose it, and it goes nowhere but the handover this device signs.
 */
export function browserTemporaryKeys(factory: IDBFactory = indexedDB): TemporaryKeys {
  const STORE = 'temporary-keys';
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open('vault-handover', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('this browser would not keep the vault\'s temporary key.'));
  });
  const run = async <T>(mode: IDBTransactionMode, act: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = act(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? new Error('this browser did not keep the vault\'s temporary key.'));
      });
    } finally {
      db.close();
    }
  };
  return {
    put: async (vault, key) => { await run('readwrite', (s) => s.put({ tag: key.tag, value: key.value }, vault)); },
    get: async (vault) => ((await run('readonly', (s) => s.get(vault))) as SigningKeyOnTheWire | undefined) ?? null,
    forget: async (vault) => { await run('readwrite', (s) => s.delete(vault)); },
  };
}

/**
 * **WHERE THIS BROWSER KEEPS A DEPOSIT OR A PAYMENT ON ITS WAY: SEALED RECORDS
 * IN INDEXEDDB, EACH CHANGE ONE TRANSACTION.**
 *
 * Every record is sealed before it reaches here (`in-flight-on-this-device.ts`),
 * so this store holds nothing it could read. Keeping a record where none is,
 * replacing one under its claim, and forgetting one under its claim each read
 * and write inside one IndexedDB transaction, and IndexedDB runs two
 * transactions on one store one after the other, so two tabs cannot both keep
 * a record in one place or lose each other's.
 */
export function browserInFlightRecords(factory: IDBFactory = indexedDB): InFlightRecords {
  const STORE = 'sealed';
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open('vault-operations-in-flight', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('this browser would not open its record of deposits and payments on their way, '
      + 'so nothing was sent and no money moved. Check that this browser lets this site store data (a private window '
      + 'may not), then try again.', { cause: req.error }));
  });
  /** One read, then at most one write, inside one transaction. */
  const step = async <T>(slot: string, decide: (there: SealedInFlight | null) => { write?: SealedInFlight | 'delete'; answer: T }): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        let answer: T;
        const read = store.get(slot);
        read.onsuccess = () => {
          const decided = decide((read.result as SealedInFlight | undefined) ?? null);
          answer = decided.answer;
          if (decided.write === 'delete') store.delete(slot);
          else if (decided.write !== undefined) store.put({ ...decided.write }, slot);
        };
        tx.oncomplete = () => resolve(answer);
        const failed = () => reject(new Error('this browser could not read or keep its record of a deposit or a payment on '
          + 'its way, so nothing was sent and no money moved. Check that this browser lets this site store data (a '
          + 'private window may not), then try again.', { cause: tx.error }));
        tx.onerror = failed;
        tx.onabort = failed;
      });
    } finally {
      db.close();
    }
  };
  return {
    get: (slot) => step(slot, (there) => ({ answer: there })),
    add: (slot, record) => step(slot, (there) => (there === null ? { write: record, answer: true } : { answer: false })),
    replace: (slot, claim, record) => step(slot, (there) => (there?.claim === claim ? { write: record, answer: true } : { answer: false })),
    remove: async (slot, claim) => { await step(slot, (there) => (there?.claim === claim ? { write: 'delete' as const, answer: undefined } : { answer: undefined })); },
  };
}

/** A deposit this signer sent from this browser and has not yet seen land, sealed under their own key. */
export const browserDepositsInFlight = (me: InFlightOpener, factory: IDBFactory = indexedDB): DepositsInFlight =>
  sealedOnThisDevice<DepositInFlight>(browserInFlightRecords(factory), me, 'deposit');

/** A payment this signer sent from this browser and has not yet seen land, sealed under their own key. */
export const browserPaymentsInFlight = (me: InFlightOpener, factory: IDBFactory = indexedDB): PaymentsInFlight =>
  sealedOnThisDevice<PaymentInFlight>(browserInFlightRecords(factory), me, 'payment');

/** A charge of a run to its vault's period this signer sent from this browser and has not yet seen land, sealed under their own key. */
export const browserChargesInFlight = (me: InFlightOpener, factory: IDBFactory = indexedDB): ChargesInFlight =>
  sealedOnThisDevice<ChargeInFlight>(browserInFlightRecords(factory), me, 'charge');
