/**
 * **WHAT THE VAULT SCREEN HANDS THE VAULT OPERATIONS**, assembled from this
 * page's own session: the company's routes over this page's own sign-in, the
 * company's records over the mounted records route, the roster this device
 * opened, and a place in this browser for a vault's temporary key.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { fromHex } from '../../../src/core/crypto.js';
import { signVaultKeys } from '../../../src/core/vault-keys.js';
import { whyNotTheCommittee, whyNotTheReaders, type Roster } from './handover-check.js';
import type { Account } from '../../../src/core/types.js';
import type { WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { PoolSigner } from '../../../src/midnight/vault-pool.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { HttpSealedPoolStore, pageWireSend, type FilingJudge, type FreshJudge } from './http-sealed-pool-store.js';
import {
  believedDirectory, FILING_REFUSAL, filingRefusalOf, seatsWithAnotherRecordsKey,
  type CommitteeKey, type Directory, type DirectoryEntry, type DirectoryFiling,
} from '../../../src/midnight/seat-directory.js';
import type { AccountHolders, DirectoryEntryStatement, RecordsKeyStatement } from 'midnight-identity/profile/records-key';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import type { DeviceRecords, DeviceSigner } from './deposit-on-device.js';
import type {
  DepositInFlight, DepositsInFlight, PaymentInFlight, PaymentsInFlight, TemporaryKeys, VaultService,
} from './vault-operation.js';
import { sealedOnThisDevice, type InFlightOpener, type InFlightRecords, type SealedInFlight } from './in-flight-on-this-device.js';
import type { SigningKeyOnTheWire } from './vault-worker-client.js';
import type { PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';

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
 * **ONE APPROVED LEG'S PAYMENTS, AS THE SERVICE REBUILT THEM FROM THE RUN THE
 * COMPANY APPROVED** - or, naming the proposal a retry on it was raised as,
 * that retry's payments and nobody else's. The viewing key travels in the
 * body, never in an address.
 */
export const privatePaymentsFor = (
  api: Api, runId: string, viewingKey: Hex, asset?: string, retry?: string,
): Promise<PrivatePaymentOrderOnTheWire> => api(`/api/runs/${encodeURIComponent(runId)}/private-payments`, {
  method: 'POST',
  body: JSON.stringify({
    viewingKey, ...(asset === undefined ? {} : { asset }), ...(retry === undefined ? {} : { proposalId: retry }),
  }),
});

/**
 * **THIS SIGNER'S TWO VAULT KEYS, SIGNED WITH THEIR OWN ROSTER SIGNING KEY AND
 * WRITTEN INTO THEIR OWN ENTRY IN THE SEALED ROSTER**, with their wallet's own
 * statement over the records key beside them. The roster signature is what
 * stops another member putting a key in this signer's name; the wallet's
 * statement over the records key and the seat this signer holds, signed by
 * the committee key the chain lists, is what every other device checks before
 * it approves a copy of a vault's secret sealed to this signer. The filing key is the roster signing key itself, so it is not sent.
 *
 * Refused before anything is sent when the statement is not for the records
 * key this device derives from the same release.
 */
export const giveVaultKeys = (
  api: Api, accountId: string,
  keys: {
    committeeKey: { tag: string; value: string }; companyKey: Hex; signingSecret: Hex; signerId: string; viewingKey: Hex;
    /** The statement this signer's wallet signed for their records key and their seat. */
    recordsKey: { readonly recordsKey: string; readonly seat: string; readonly signature: string };
  },
): Promise<unknown> => {
  const recordsKey = recordsKeypairFrom(fromHex(keys.companyKey)).publicKey;
  if (keys.recordsKey.recordsKey.toLowerCase() !== recordsKey.toLowerCase()) {
    return Promise.reject(new Error('your wallet signed a records key that is not the one your company key gives, so '
      + 'your vault keys were not given. Open the company with your wallet again.'));
  }
  const signed = signVaultKeys(accountId, keys.signerId, {
    committeeKey: keys.committeeKey, recordsKey,
    recordsKeyStatement: keys.recordsKey.signature as Hex, recordsKeySeat: keys.recordsKey.seat as Hex,
  }, keys.signingSecret);
  return api(`/api/accounts/${encodeURIComponent(accountId)}/vault-keys`, {
    method: 'PUT',
    body: JSON.stringify({ viewingKey: keys.viewingKey, ...signed }),
  });
};

/** This device as a signer of the company's vaults. */
export const deviceSignerFrom = (
  secrets: { signerId: string; wrappingSecret: Hex }, companyKey: Hex,
): DeviceSigner => ({ signerId: secrets.signerId, wrappingSecret: secrets.wrappingSecret, companyKey: fromHex(companyKey) });

/** Everybody on the roster this device opened: who the pool is wrapped to. Whose filings are believed is `directoryJudge`'s. */
export const rosterOf = (account: Account) => {
  const active = account.signers.filter((s) => s.status === 'active');
  return {
    signers: async (): Promise<readonly PoolSigner[]> =>
      active.map((s) => ({ id: s.id, wrappingPublicKey: s.wrappingPublicKey })),
  };
};

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
export const directoryJudge = (deps: {
  readonly filings: () => Promise<readonly DirectoryFiling[]>;
  readonly label: CompanyLabel;
  readonly accountId: string;
  /** Who holds the account now and its approval threshold, as the person's own wallet read it for this read. */
  readonly holders: () => Promise<AccountHolders>;
  /** The records-key statements in the roster this device opened. */
  readonly attested: () => Promise<readonly { committeeKey: CommitteeKey; statement: RecordsKeyStatement }[]>;
}): FreshJudge => async () => {
  let filings: readonly DirectoryFiling[];
  let holders: AccountHolders;
  let attested: readonly { committeeKey: CommitteeKey; statement: RecordsKeyStatement }[];
  try {
    [filings, holders, attested] = await Promise.all([deps.filings(), deps.holders(), deps.attested()]);
  } catch (e) {
    const why = `who filed it could not be checked (${(e as Error)?.message ?? String(e)})`;
    return () => why;
  }
  const dir: Directory = believedDirectory(deps.accountId, filings, deps.label, { approvals: holders.approvals, seats: holders.seats, committee: holders.committee });
  const another = seatsWithAnotherRecordsKey(dir, deps.label, attested);
  const judge: FilingJudge = (filer, kind, recordKey, version) => {
    if (filer === null) return 'it carries no valid signature for this record';
    const seat = dir.seats.find((x) => x.signingKey === filer.toLowerCase());
    if (seat !== undefined && another.has(seat.seat)) {
      return 'it is signed by a seat whose own wallet has not attested the records key its directory entry names';
    }
    const refused = filingRefusalOf(dir, holders, filer, kind, recordKey, version);
    return refused === null ? null : FILING_REFUSAL[refused];
  };
  return judge;
};

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
export const fileOwnDirectoryEntry = async (
  api: Api, accountId: string, person: string, label: CompanyLabel,
  signed: { readonly committeeKey: CommitteeKey; readonly entry: DirectoryEntryStatement },
): Promise<'filed' | 'already-there'> => {
  const filings = await directoryFilingsFrom(api, accountId);
  const dir = believedDirectory(accountId, filings, label);
  const mine = dir.seats.find((x) => x.seat === signed.entry.seat);
  if (mine !== undefined && mine.signingKey === signed.entry.signingKey && mine.wrappingKey === signed.entry.wrappingKey) {
    return 'already-there';
  }
  const entry: DirectoryEntry = { person, committeeKey: { ...signed.committeeKey }, statement: { ...signed.entry } };
  const filing: DirectoryFiling = { company: accountId, version: filings.length + 1, change: { kind: 'claim', entry } };
  await api(`/api/accounts/${encodeURIComponent(accountId)}/directory/${filing.version}`, { method: 'PUT', body: JSON.stringify(filing) });
  return 'filed';
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
