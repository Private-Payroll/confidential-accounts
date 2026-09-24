import type { Hex } from '../core/crypto.js';
import {
  openPayslip, answerPayslipProof, NOT_YOUR_PAYSLIP,
  type SealedPayslip, type OpenedPayslip,
} from '../core/payslip-open.js';
import type { WrappingKeypair } from '../core/crypto.js';

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
/* whether each payslip was paid, from the company's public record      */
/* ------------------------------------------------------------------ */

/**
 * **WHAT THE COMPANY'S RECORD SAYS ABOUT ONE PAYSLIP.** `'paid'` only when the
 * company's public record of completed payments, as the service relays it,
 * was read and holds this payment; `'not-yet'` only when it was read and does
 * not; `'cannot-tell'` whenever it was not read, whatever the reason. Nothing
 * that failed is ever reported as not paid. The list is the service's report
 * of the chain, and nothing on this device checks it against the chain.
 */
export type OnTheChain = 'paid' | 'not-yet' | 'cannot-tell';

const HEX32 = /^[0-9a-f]{64}$/u;

/** One company's completed payments as the service relayed them, or `null` when they could not be read. */
async function completedPaymentsAt(company: string, fetcher: Fetch): Promise<Set<string> | null> {
  try {
    const r = await fetcher(
      `/api/payslips/paid?company=${encodeURIComponent(company)}`, { credentials: 'omit' });
    if (!r.ok) return null;
    const body = await r.json();
    if (body?.known !== true || !Array.isArray(body.movements)) return null;
    const out = new Set<string>();
    for (const m of body.movements) {
      if (typeof m !== 'string' || !HEX32.test(m.toLowerCase())) return null;
      out.add(m.toLowerCase());
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * **ASKS, FOR EACH SLIP THAT CARRIES A RECEIPT, WHETHER ITS PAYMENT IS IN THE
 * COMPANY'S RECORD OF COMPLETED PAYMENTS - WITHOUT SAYING WHICH PAYMENT.**
 *
 * Each receipt was opened on this device and holds the value the company's
 * account records when this person's payment is made. What is asked for is the
 * company's whole list of completed payments, by company address, and the
 * value is looked for in it here. So no request names a leaf, a payment or a
 * person, and one list answers every slip from that company.
 *
 * A slip with no receipt is not in the answer: nothing can be asked for it.
 */
export async function paymentsOnTheChain(
  slips: OpenedPayslip[], fetcher: Fetch = fetch,
): Promise<Map<string, OnTheChain>> {
  const lists = new Map<string, Promise<Set<string> | null>>();
  const out = new Map<string, OnTheChain>();
  for (const s of slips) {
    if (!s.receipt) continue;
    const company = s.receipt.company;
    if (company === null) { out.set(s.runId, 'cannot-tell'); continue; }
    if (!lists.has(company)) lists.set(company, completedPaymentsAt(company, fetcher));
    const list = await lists.get(company)!;
    out.set(s.runId, list === null ? 'cannot-tell' : list.has(s.receipt.movement) ? 'paid' : 'not-yet');
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
