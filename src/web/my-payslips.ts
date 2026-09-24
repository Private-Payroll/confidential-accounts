import type { Hex } from '../core/crypto.js';
import {
  openPayslip, answerPayslipProof, NOT_YOUR_PAYSLIP,
  type SealedPayslip, type OpenedPayslip,
} from '../core/payslip-open.js';
import type { WrappingKeypair } from '../core/crypto.js';
import type { WalletIndexer } from 'midnight-identity/profile/unlock';
import type { ChainReader } from './payslip-worker-client.js';

/**
 * **A PAYEE'S OWN PAYSLIPS, FETCHED AS CIPHERTEXT AND OPENED ON THIS DEVICE.**
 *
 * The secret in `keys` is used twice, both times here: once to read back the
 * value the service sealed to its public half, which is how the service knows
 * to answer, and once per slip to open it. It is never part of a request.
 *
 * The requests go without this page's sign-in. Which signed-in person is paid
 * by which company is kept sealed inside the company's records, and a lookup
 * carrying a sign-in would hand the service that link in the clear.
 */
/** Where a payee's own payslips are. */
export const YOUR_PAY_PATH = '/payslips';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const withoutSignIn = (body: unknown): RequestInit => ({
  method: 'POST',
  credentials: 'omit',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const readJson = async (r: Response, doing: string): Promise<any> => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error ?? `${doing} failed (${r.status})`);
  return body;
};

export interface MyPayslips {
  opened: OpenedPayslip[];
  /** What the service sent, still sealed. */
  sealed: SealedPayslip[];
  /**
   * Slips the service sent that this key did not open. Always zero unless
   * something is wrong, and counted rather than dropped so a page can say so.
   */
  unopened: number;
  /**
   * Slips that opened but name a company address other than the one this key
   * was worked out from. The key was handed to that one company only, so a
   * slip naming another was put there by a company this person never accepted,
   * and it is not shown.
   */
  refused: number;
}

/**
 * @param from the company address `keys` was worked out from, or `null` for a
 *   key no address produced. Only slips that name exactly that are asked for,
 *   and only those are shown.
 */
export async function fetchMyPayslips(
  keys: WrappingKeypair, from: string | null, fetcher: Fetch = fetch,
): Promise<MyPayslips> {
  const address = from === null ? null : from.toLowerCase();
  const proof = await readJson(
    await fetcher('/api/payslips/proof', withoutSignIn({ publicKey: keys.publicKey })),
    'asking for your payslips');
  const answer: Hex = answerPayslipProof(proof.sealed, keys.secret);
  const sealed: SealedPayslip[] = await readJson(
    await fetcher('/api/payslips', withoutSignIn({ publicKey: keys.publicKey, answer, from: address })),
    'fetching your payslips');
  const opened: OpenedPayslip[] = [];
  let unopened = 0;
  let refused = 0;
  for (const entry of sealed) {
    let slip: OpenedPayslip;
    try {
      slip = openPayslip(entry, keys.secret);
    } catch (e) {
      if (!(e instanceof Error) || e.message !== NOT_YOUR_PAYSLIP) throw e;
      unopened += 1;
      continue;
    }
    if ((slip.issuedBy === null ? null : slip.issuedBy.toLowerCase()) !== address) { refused += 1; continue; }
    opened.push(slip);
  }
  return { opened, sealed, unopened, refused };
}

/* ------------------------------------------------------------------ */
/* whether each payslip was paid, from what the wallet's indexer reports */
/* ------------------------------------------------------------------ */

/**
 * **WHAT THE COMPANY'S ACCOUNT RECORDS ABOUT ONE PAYSLIP, AS THIS DEVICE READ
 * IT.** The state read is the one the indexer the payee's wallet names reports
 * for the contract; nothing on this device checks it against the chain beyond
 * that. And the receipt is written by the service, so which contract is read
 * and which value is looked for come from it. `'paid'` only when the account's
 * public set of completed payments was
 * read and holds this payment; `'not-yet'` only when it was read, does not
 * hold it, and the window this payment can still be made in has not closed;
 * `'cannot-tell'` whenever it was not read, whatever the reason, and when the
 * window has closed or was never known. Nothing that failed is ever reported
 * as not paid, and nothing here asks this application's service.
 */
export type OnTheChain = 'paid' | 'not-yet' | 'cannot-tell';

/**
 * **ASKS, FOR EACH SLIP THAT CARRIES A RECEIPT, WHETHER ITS PAYMENT IS IN THE
 * COMPANY'S RECORD OF COMPLETED PAYMENTS - READ BY THIS DEVICE, NOT ASKED OF
 * THIS APPLICATION'S SERVICE.**
 *
 * Each receipt was opened on this device and holds the value the company's
 * account records when this person's payment is made. The reader is this
 * page's own worker, reading the company's contract through the indexer the
 * payee's wallet named; it asks the indexer for the contract by its address
 * and tests the values here; the indexer does learn that this device asked
 * about that company. With no indexer, or no reader, every slip that
 * carries a receipt says that it cannot tell.
 *
 * A slip with no receipt is not in the answer: nothing can be asked for it.
 *
 * @param nowSeconds this device's clock, in seconds, compared against the end
 *   of each payment's window. Approximate, and only ever used to stop saying
 *   "not yet".
 */
export async function paymentsOnTheChain(
  slips: OpenedPayslip[], reader: ChainReader | null, indexer: WalletIndexer | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<Map<string, OnTheChain>> {
  const out = new Map<string, OnTheChain>();
  const byCompany = new Map<string, OpenedPayslip[]>();
  for (const s of slips) {
    if (!s.receipt) continue;
    const company = s.receipt.company;
    if (company === null || reader === null || indexer === null) { out.set(s.runId, 'cannot-tell'); continue; }
    byCompany.set(company, [...(byCompany.get(company) ?? []), s]);
  }
  for (const [company, mine] of byCompany) {
    let recorded: boolean[] | null;
    try {
      recorded = await reader!.recorded(indexer!, company, mine.map(s => s.receipt!.movement));
    } catch {
      recorded = null;
    }
    mine.forEach((s, i) => {
      const r = recorded?.[i];
      if (recorded === null || typeof r !== 'boolean') { out.set(s.runId, 'cannot-tell'); return; }
      if (r) { out.set(s.runId, 'paid'); return; }
      const until = s.receipt!.until;
      out.set(s.runId, until !== null && nowSeconds < until ? 'not-yet' : 'cannot-tell');
    });
  }
  return out;
}

/** Every address a company's payslips were sealed under, asked by any one of them. */
export async function payslipAddressesFor(company: string, fetcher: Fetch = fetch): Promise<string[]> {
  const r = await fetcher(
    `/api/payslips/addresses?company=${encodeURIComponent(company)}`,
    { credentials: 'omit' });
  const body = await readJson(r, 'asking which addresses a company has had');
  return Array.isArray(body.addresses) ? body.addresses : [];
}

/* ------------------------------------------------------------------ */
/* which companies this browser has been told pay you                   */
/* ------------------------------------------------------------------ */

/**
 * **A LIST OF COMPANY ADDRESSES, AND NOTHING ELSE.** Contract addresses are
 * public, so keeping them in this browser keeps nothing that opens anything:
 * the key that opens a slip is worked out from the wallet each time and is not
 * kept here or anywhere. Another device starts with an empty list, and the
 * person adds the company's address there.
 */
const REMEMBERED = 'payslip-companies';
const COMPANY_ADDRESS = /^[0-9a-f]{64}$/u;

export const tidyCompanyAddress = (text: string): string | null => {
  const t = text.trim().toLowerCase().replace(/^0x/u, '');
  return COMPANY_ADDRESS.test(t) ? t : null;
};

export function rememberedCompanies(storage: Pick<Storage, 'getItem'> | null = safeStorage()): string[] {
  try {
    const raw = storage?.getItem(REMEMBERED);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === 'string' && COMPANY_ADDRESS.test(a)) : [];
  } catch {
    return [];
  }
}

export function rememberCompany(
  address: string, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage(),
): string[] {
  const tidy = tidyCompanyAddress(address);
  const list = rememberedCompanies(storage);
  if (tidy === null || list.includes(tidy)) return list;
  const next = [...list, tidy];
  try { storage?.setItem(REMEMBERED, JSON.stringify(next)); } catch { /* kept for this visit only */ }
  return next;
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
