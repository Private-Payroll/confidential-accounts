/**
 * **WHAT THE VAULT SCREEN HANDS THE VAULT OPERATIONS**, assembled from this
 * page's own session: the company's routes over this page's own sign-in, the
 * company's records over the mounted records route, the roster this device
 * opened, and a place in this browser for a vault's temporary key.
 */
import type { Hex } from '../core/crypto.js';
import { fromHex } from '../core/crypto.js';
import { signVaultKeys } from '../core/vault-keys.js';
import { whyNotTheCommittee, whyNotTheReaders, type Roster } from './handover-check.js';
import type { Account } from '../core/types.js';
import type { WireRecord } from '../midnight/sealed-record-wire.js';
import type { PoolSigner } from '../midnight/vault-pool.js';
import { recordsKeypairFrom } from '../midnight/company-nonce-secret.js';
import { HttpSealedPoolStore, pageWireSend } from './http-sealed-pool-store.js';
import type { DeviceRecords, DeviceSigner } from './deposit-on-device.js';
import type { TemporaryKeys, VaultService } from './vault-operation.js';
import type { SigningKeyOnTheWire } from './vault-worker-client.js';
import type { PrivatePaymentOrderOnTheWire } from '../midnight/private-payment-wire.js';

type Api = (path: string, init?: RequestInit) => Promise<any>;

/** A refusal from the service keeps the service's own mark of whether anything was sent. */
const marked = async <T>(call: () => Promise<T>): Promise<T> => {
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
        ?? whyNotTheReaders(served.readers ?? [], named);
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
    payoutState: (vault) => api(`${base}/vaults/${vault}/payout-state`),
    events: (vault, transactionHash) => api(`${base}/vaults/${vault}/events/${encodeURIComponent(transactionHash)}`),
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

/** Gives this signer's three public vault keys, once; the service keeps the first set. */
/**
 * **THIS SIGNER'S TWO VAULT KEYS, SIGNED WITH THEIR OWN ROSTER SIGNING KEY AND
 * WRITTEN INTO THEIR OWN ENTRY IN THE SEALED ROSTER.** The signature is what lets
 * every other device accept them as this signer's, and what stops anybody else
 * putting a key in this signer's name. The filing key is the roster signing key
 * itself, so it is not sent.
 */
export const giveVaultKeys = (
  api: Api, accountId: string,
  keys: { committeeKey: { tag: string; value: string }; companyKey: Hex; signingSecret: Hex; signerId: string; viewingKey: Hex },
): Promise<unknown> => {
  const signed = signVaultKeys(accountId, keys.signerId, {
    committeeKey: keys.committeeKey, recordsKey: recordsKeypairFrom(fromHex(keys.companyKey)).publicKey,
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

/** Everybody on the roster this device opened: who the pool is wrapped to, and whose filings are believed. */
export const rosterOf = (account: Account) => {
  const active = account.signers.filter((s) => s.status === 'active');
  return {
    signers: async (): Promise<readonly PoolSigner[]> =>
      active.map((s) => ({ id: s.id, wrappingPublicKey: s.wrappingPublicKey })),
    filers: async (): Promise<ReadonlySet<Hex>> => new Set(active.map((s) => s.signingPublicKey.toLowerCase())),
  };
};

export const deviceRecordsFor = (
  signingSecret: Hex, filers: () => Promise<ReadonlySet<Hex>>, signedInAs: () => string | null,
): DeviceRecords => {
  const send = pageWireSend(signedInAs);
  return (record: WireRecord) => new HttpSealedPoolStore(record, send, signingSecret, filers);
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
