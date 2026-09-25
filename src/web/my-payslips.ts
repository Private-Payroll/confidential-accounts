import type { Hex } from '../core/crypto.js';
import {
  openPayslip, answerPayslipProof, NOT_YOUR_PAYSLIP,
  type SealedPayslip, type OpenedPayslip,
} from '../core/payslip-open.js';
import type { WrappingKeypair } from '../core/crypto.js';
import type { WalletIndexer } from 'midnight-identity/profile/unlock';
import type { ChainReader } from './payslip-worker-client.js';
import { PAGE_OUT_OF_DATE, PAYSLIP_PAGE_HEADER, PAYSLIP_PAGE_VERSION } from '../core/payslip-page.js';

/**
 * **A PAYEE'S OWN PAYSLIPS, FETCHED AS CIPHERTEXT AND OPENED ON THIS DEVICE.**
 *
 * The secret in `keys` is used twice, both times here: once to read back the
 * value the service sealed to its public half, which is how the service knows
 * to answer, and once per slip to open it. It is never part of a request.
 *
 * The requests carry this page's sign-in, because the service answers a
 * signed-in person only, and they name this page so that a page older than the
 * service is told to reload rather than to sign in again. While it answers, the
 * service therefore sees which signed-in person asks about which company
 * address; it does not write that down.
 */
/** An address that opens this application, kept so links to it still arrive. */
export const YOUR_PAY_PATH = '/payslips';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What every payslip request carries: the sign-in cookie, to this origin only, and the page's name. */
const asThisPage = (init: RequestInit = {}): RequestInit => ({
  ...init,
  credentials: 'same-origin',
  headers: {
    'content-type': 'application/json',
    [PAYSLIP_PAGE_HEADER]: PAYSLIP_PAGE_VERSION,
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  },
});

const signedIn = (body: unknown): RequestInit => asThisPage({ method: 'POST', body: JSON.stringify(body) });

/** Thrown when the service says this page is older than it. Never caught as one address's failure. */
export class PageOutOfDate extends Error {
  constructor() { super(PAGE_OUT_OF_DATE); this.name = 'PageOutOfDate'; }
}

const readJson = async (r: Response, doing: string): Promise<any> => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok && body?.code === 'payslip-page-out-of-date') throw new PageOutOfDate();
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
    await fetcher('/api/payslips/proof', signedIn({ publicKey: keys.publicKey })),
    'asking for your payslips');
  const answer: Hex = answerPayslipProof(proof.sealed, keys.secret);
  const sealed: SealedPayslip[] = await readJson(
    await fetcher('/api/payslips', signedIn({ publicKey: keys.publicKey, answer, from: address })),
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
  return (await readTheChain(slips, reader, indexer, nowSeconds)).chain;
}

/**
 * **THE SAME READ, AND WHETHER IT COULD BE MADE AT ALL.** `couldNotRead` is
 * true when a slip that carries a receipt could not be asked about because the
 * wallet named no indexer or there is no reader, or when a read failed or came
 * back as something that is not an answer. It is what lets a page say why its
 * rows cannot tell, rather than only that they cannot.
 */
export async function readTheChain(
  slips: OpenedPayslip[], reader: ChainReader | null, indexer: WalletIndexer | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ chain: Map<string, OnTheChain>; couldNotRead: boolean }> {
  const out = new Map<string, OnTheChain>();
  let couldNotRead = false;
  const byCompany = new Map<string, OpenedPayslip[]>();
  for (const s of slips) {
    if (!s.receipt) continue;
    const company = s.receipt.company;
    if (company !== null && (reader === null || indexer === null)) couldNotRead = true;
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
      if (recorded === null || typeof r !== 'boolean') { couldNotRead = true; out.set(s.runId, 'cannot-tell'); return; }
      if (r) { out.set(s.runId, 'paid'); return; }
      const until = s.receipt!.until;
      out.set(s.runId, until !== null && nowSeconds < until ? 'not-yet' : 'cannot-tell');
    });
  }
  return { chain: out, couldNotRead };
}

/** Every address a company's payslips were sealed under, asked by any one of them. */
export async function payslipAddressesFor(company: string, fetcher: Fetch = fetch): Promise<string[]> {
  const r = await fetcher(
    `/api/payslips/addresses?company=${encodeURIComponent(company)}`,
    asThisPage());
  const body = await readJson(r, 'asking which addresses a company has had');
  return Array.isArray(body.addresses) ? body.addresses : [];
}

/* ------------------------------------------------------------------ */
/* which companies pay you, as this browser holds them for one person   */
/* ------------------------------------------------------------------ */

/**
 * **A LIST OF COMPANY ADDRESSES, AND NOTHING ELSE, KEPT FOR ONE SIGNED-IN
 * PERSON.** The list that follows a person to every device is inside their own
 * saved keys (`keyring.ts`). This one holds, in this browser only, an address
 * that could not be saved there yet, until it can be. It is keyed by the
 * person, so somebody else signing in in this browser is never shown it.
 * Contract addresses are public, and nothing here opens anything.
 */
const REMEMBERED = 'payslip-companies-of:';
const COMPANY_ADDRESS = /^[0-9a-f]{64}$/u;

export const tidyCompanyAddress = (text: string): string | null => {
  const t = text.trim().toLowerCase().replace(/^0x/u, '');
  return COMPANY_ADDRESS.test(t) ? t : null;
};

/** Only well-formed company addresses, each once. */
export const onlyCompanyAddresses = (list: unknown): string[] =>
  Array.isArray(list)
    ? [...new Set(list.filter((a): a is string => typeof a === 'string' && COMPANY_ADDRESS.test(a)))]
    : [];

export function rememberedCompanies(
  person: string, storage: Pick<Storage, 'getItem'> | null = safeStorage(),
): string[] {
  try {
    const raw = storage?.getItem(REMEMBERED + person);
    return onlyCompanyAddresses(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

export function rememberCompany(
  person: string, address: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage(),
): string[] {
  const tidy = tidyCompanyAddress(address);
  const list = rememberedCompanies(person, storage);
  if (tidy === null || list.includes(tidy)) return list;
  const next = [...list, tidy];
  try { storage?.setItem(REMEMBERED + person, JSON.stringify(next)); } catch { /* kept for this visit only */ }
  return next;
}

/** Empties one person's list in this browser, once what it held has been saved with them. */
export function forgetRememberedCompanies(
  person: string, storage: Pick<Storage, 'removeItem'> | null = safeStorage(),
): void {
  try { storage?.removeItem(REMEMBERED + person); } catch { /* nothing to empty */ }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
