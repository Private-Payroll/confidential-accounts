/**
 * **WHAT THE VAULT SCREEN HANDS THE VAULT OPERATIONS**, assembled from this
 * page's own session: the company's routes over this page's own sign-in, the
 * company's records over the mounted records route, the roster this device
 * opened, and a place in this browser for a vault's temporary key.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { fromHex } from '../../../src/core/crypto.js';
import { whyNotTheCommittee, whyNotTheReaders, type Roster } from './handover-check.js';
import type { Account } from '../../../src/core/types.js';
import type { WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { PoolSigner } from '../../../src/midnight/vault-pool.js';
import { admitToNonceSecret, openNonceSecrets, recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { HttpSealedPoolStore, pageWireSend, type FilingJudge, type FreshJudge } from './http-sealed-pool-store.js';
import {
  believedDirectory, FILING_REFUSAL, filingRefusalOf, notOnTheChainNow, seatsWithAnotherRecordsKey,
  type CommitteeKey, type Directory, type DirectoryEntry, type DirectoryFiling, type DirectorySeat, type FiledKind,
} from '../../../src/midnight/seat-directory.js';
import type { AccountHoldersRead, DirectoryEntryStatement, RecordsKeyStatement } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { DeviceRecords, DeviceSigner } from './deposit-on-device.js';
import type {
  DepositInFlight, DepositsInFlight, PaymentInFlight, PaymentsInFlight, TemporaryKeys, VaultService,
} from './vault-operation.js';
import { sealedOnThisDevice, type InFlightOpener, type InFlightRecords, type SealedInFlight } from './in-flight-on-this-device.js';
import type { SigningKeyOnTheWire } from './vault-worker-client.js';

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
    events: (vault, transactionHash) => api(`${base}/vaults/${vault}/events/${encodeURIComponent(transactionHash)}`),
    createdBy: async (vault, commitment) => {
      const answer = await api(`${base}/vaults/${vault}/created/${encodeURIComponent(commitment)}`);
      return answer?.found === true ? { transactionHash: answer.transactionHash, events: answer.events } : null;
    },
    payout: (vault, tx) => post(`${base}/vaults/${vault}/payout`, tx),
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
export const readersIn = (directory: () => Promise<DirectoryHere>) => ({
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
}

/** A company's directory as this device believes it for one read, with the read of the chain it was believed against. */
export interface DirectoryHere {
  readonly dir: Directory;
  readonly holders: AccountHoldersRead;
  /** The seats whose entry names a wrapping key their own wallet did not attest. */
  readonly another: ReadonlySet<string>;
}

/**
 * **THE DIRECTORY THIS DEVICE BELIEVES, READ AFRESH.** Replayed against the
 * account this person's own wallet read who holds, and the only one an entry or
 * a statement is believed for. Throws when anything it reads cannot be read.
 */
export const directoryHere = async (deps: DirectoryHereDeps): Promise<DirectoryHere> => {
  const [filings, holders, attested] = await Promise.all([deps.filings(), deps.holders(), deps.attested()]);
  const dir: Directory = believedDirectory(deps.accountId, filings, deps.label, holders.account,
    { approvals: holders.approvals, seats: holders.seats, committee: holders.committee });
  return { dir, holders, another: seatsWithAnotherRecordsKey(dir, deps.label, holders.account, attested) };
};

/**
 * **THE FOUNDING SEAT'S ENTRY, AS THIS DEVICE BELIEVES IT**, or why not. The
 * founding seat is the deploy's, as the person's own wallet read it
 * (`holders.founding`), and its entry speaks for it only when signed by the
 * committee key the deploy held the account by (`holders.foundingCommittee`):
 * an entry the directory keeps whether the seat is held now or not, and no
 * entry under another key speaks for that seat. The one rule for the records
 * a company is founded with: its first state and its first roster.
 */
export const foundingSeatHere = (here: DirectoryHere): DirectorySeat | string => {
  const seat = here.dir.seats.find((s) => s.seat === here.holders.founding);
  if (seat === undefined) return 'the seat the company\'s account was deployed with has no entry in its directory that this device believes';
  const byTheFoundingKey = here.holders.foundingCommittee.some((k) =>
    k.tag === seat.committeeKey.tag && k.value.toLowerCase() === seat.committeeKey.value.toLowerCase());
  return byTheFoundingKey ? seat
    : 'the founding seat\'s directory entry is not signed by the committee key the company\'s account was deployed with';
};

/**
 * Why this device does not believe a filing signed by `filer`, of kind `kind`,
 * counted under `recordKey` at `version`, or null when it does: one rule for
 * every filing it reads and every copy it gives.
 */
const refusalHere = (here: DirectoryHere, filer: Hex | null, kind: FiledKind, recordKey: string, version: number): string | null => {
  if (filer === null) return 'it carries no valid signature for this record';
  const seat = here.dir.seats.find((x) => x.signingKey === filer.toLowerCase());
  if (seat !== undefined && here.another.has(seat.seat)) {
    return 'it is signed by a seat whose own wallet has not attested the records key its directory entry names';
  }
  const refused = filingRefusalOf(here.dir, here.holders, filer, kind, recordKey, version);
  return refused === null ? null : FILING_REFUSAL[refused];
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

/** Who this device believes filed a version, by the directory it believes for one read. */
export const judgeIn = (here: DirectoryHere): FilingJudge => (filer, kind, recordKey, version) => refusalHere(here, filer, kind, recordKey, version);

/**
 * **WHO THIS DEVICE BELIEVES FILED A VERSION, WORKED OUT AFRESH FOR EVERY
 * READ.** The directory is read again and replayed here, and the chain is read
 * again by the person's own wallet (`holders`, with no press): a version is
 * believed only when an entry the seat's own wallet signed names its key, the
 * seat is seated now and on the committee, its role may file the record, and
 * its entry's wrapping key is the records key its wallet attested in the
 * roster this device opened, under the key that signed its entry: a seat with
 * no such statement is refused, never skipped. Nothing of one read is kept for the next.
 */
export const directoryJudge = (deps: DirectoryHereDeps): FreshJudge => async () => {
  let here: DirectoryHere;
  try {
    here = await directoryHere(deps);
  } catch (e) {
    const why = `who filed it could not be checked (${(e as Error)?.message ?? String(e)})`;
    return () => why;
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
  readonly directory: () => Promise<DirectoryHere>;
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
  signingSecret: Hex, judge: FreshJudge, signedInAs: () => string | null,
): DeviceRecords => {
  const send = pageWireSend(signedInAs);
  return (record: WireRecord) => new HttpSealedPoolStore(record, send, signingSecret, judge);
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
  await api(`/api/accounts/${encodeURIComponent(accountId)}/directory/${filing.version}`, { method: 'PUT', body: JSON.stringify(filing) });
  return 'filed';
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
