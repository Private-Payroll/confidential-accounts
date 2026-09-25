import type { Hex } from '../core/crypto.js';
import {
  openPayslip, answerPayslipProof, NOT_YOUR_PAYSLIP,
  type SealedPayslip, type OpenedPayslip,
} from '../core/payslip-open.js';
import type { WrappingKeypair } from '../core/crypto.js';
import type { WalletIndexer } from 'midnight-identity/profile/unlock';
import type { ChainReader, PayslipPayment } from './payslip-worker-client.js';
import { assets, ledgerTokenOf, type AssetRegistry } from '../core/assets.js';
import { paidPublicly } from './public-payment.js';
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
 * that. The value looked for is built on this device from the address the
 * payee's own wallet confirmed, the slip's token and amount, and the payee's
 * own nonce and blinding; which contract is read is the one the receipt names,
 * and only when it is an address this page opened for that company.
 * `'paid'` only when the account's public set of completed payments was
 * read and holds this payment; `'not-yet'` only when it was read, does not
 * hold it, and the window this payment can still be made in has not closed;
 * `'cannot-tell'` whenever the wallet did not confirm the address, whenever the
 * receipt names a contract this page did not open for that company, whenever it
 * was not read, whatever the reason, and when the window has closed or was
 * never known. Nothing that failed is ever reported as not paid, and nothing
 * here asks this application's service.
 */
export type OnTheChain = 'paid' | 'not-yet' | 'cannot-tell';

/**
 * **ASKS, FOR EACH SLIP THAT CARRIES A RECEIPT, WHETHER ITS PAYMENT IS IN THE
 * COMPANY'S RECORD OF COMPLETED PAYMENTS - READ BY THIS DEVICE, NOT ASKED OF
 * THIS APPLICATION'S SERVICE.**
 *
 * Each receipt was opened on this device and holds this person's own nonce and
 * blinding. A slip whose address their wallet confirmed is asked about: this
 * page's own worker builds from it the value the company's account records
 * when that payment is made, reads the company's contract through the indexer
 * the payee's wallet named, and tests the value there. The indexer learns only
 * that this device asked about that company. With no indexer, or no reader,
 * every slip that carries a receipt says that it cannot tell.
 *
 * A slip with no receipt is not in the answer: nothing can be asked for it.
 *
 * @param nowSeconds this device's clock, in seconds, compared against the end
 *   of each payment's window. Approximate, and only ever used to stop saying
 *   "not yet".
 */
export async function paymentsOnTheChain(
  slips: OpenedPayslip[], reader: ChainReader | null, indexer: WalletIndexer | null,
  confirmed: (slip: OpenedPayslip) => boolean,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  registry: AssetRegistry = assets,
  openedFor?: Iterable<string>,
): Promise<Map<string, OnTheChain>> {
  return (await readTheChain(slips, reader, indexer, confirmed, nowSeconds, registry, openedFor)).chain;
}

/**
 * **ONE SLIP'S PAYMENT AS THIS DEVICE KNOWS IT, OR `null`.** The address is the
 * slip's own and is used only once `confirmed` has said the payee's wallet holds
 * it; the token is the ledger's for the slip's asset, from this page's own
 * registry. Anything missing or unreadable is `null`, which reads as "cannot
 * tell".
 */
const paymentOf = (s: OpenedPayslip, registry: AssetRegistry): PayslipPayment | null => {
  const r = s.receipt;
  const paidTo = s.payslip.paidTo;
  if (r === null || typeof paidTo !== 'string' || typeof s.payslip.amount !== 'bigint') return null;
  /*
   * **A PUBLIC PAYMENT IS ASKED ABOUT IN ITS OWN FORM.** The token is the
   * asset's public token when the slip was paid to a public address and its
   * private token otherwise, read off the address the slip names; the device's
   * reader builds the value with the details commitment of that same kind. A
   * value built in the other form was never recorded, and would read "not yet"
   * for a payment that was made. A slip reaches here only once `confirmed` has
   * said the payee's wallet holds its address, and the wallet answers for no
   * public address today, so a public payment still reads "cannot tell".
   */
  const form = paidPublicly(paidTo) ? 'unshielded' : 'shielded';
  try {
    return {
      paidTo, token: ledgerTokenOf(s.payslip.asset, form, registry) as Hex, amount: s.payslip.amount.toString(),
      nonce: r.nonce, blinding: r.blinding,
    };
  } catch {
    return null;
  }
};

/**
 * **THE SAME READ, AND WHETHER IT COULD BE MADE AT ALL.** `couldNotRead` is
 * true when a slip that carries a receipt could not be asked about because the
 * wallet named no indexer or there is no reader, or when a read failed or came
 * back as something that is not an answer. It is what lets a page say why its
 * rows cannot tell, rather than only that they cannot.
 *
 * **ONLY A CONTRACT THIS PAGE OPENED FOR THAT COMPANY IS READ.** A receipt is
 * sealed by the service, so the contract it names is the service's word. So a
 * receipt is asked about only when the contract it names is one of
 * `openedFor`: the addresses whose key the payee's wallet gave and whose slips
 * this page then fetched and opened. A receipt alone therefore cannot send this
 * page to a contract the service deployed for itself. What this does not stop:
 * the addresses a company's payslips were sealed under are also the service's
 * answer, so a service that names its own contract there, and whose payee
 * approves that address in their wallet, has it opened too. A company that
 * moved has in that set its address now and every address its slips were
 * sealed under, so a payment recorded at one of those still reads. Any other
 * receipt reads "cannot tell", and that is not a failure to read.
 *
 * @param openedFor the company addresses this page opened. Left out, it is the
 *   addresses the slips themselves were opened at, which is never wider: a slip
 *   reaches this page only from the address it was fetched for.
 */
export async function readTheChain(
  slips: OpenedPayslip[], reader: ChainReader | null, indexer: WalletIndexer | null,
  /** Whether the payee's own wallet confirmed it holds the address this slip was paid to. */
  confirmed: (slip: OpenedPayslip) => boolean,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  /** The assets this page knows, the same registry the service pays from. */
  registry: AssetRegistry = assets,
  openedFor?: Iterable<string>,
): Promise<{ chain: Map<string, OnTheChain>; couldNotRead: boolean }> {
  const out = new Map<string, OnTheChain>();
  let couldNotRead = false;
  const opened = openedAddresses(openedFor ?? slips.map(s => s.issuedBy));
  const byCompany = new Map<string, { slip: OpenedPayslip; payment: PayslipPayment }[]>();
  for (const s of slips) {
    if (!s.receipt) continue;
    const company = s.receipt.company;
    /* A contract this page did not open for the company is never read, whatever else is known. */
    if (company === null || !opened.has(company)) { out.set(s.runId, 'cannot-tell'); continue; }
    if (reader === null || indexer === null) { couldNotRead = true; out.set(s.runId, 'cannot-tell'); continue; }
    /* An address the wallet did not confirm is never asked about: nothing read for it could be "not yet". */
    const payment = confirmedSafely(confirmed, s) ? paymentOf(s, registry) : null;
    if (payment === null) { out.set(s.runId, 'cannot-tell'); continue; }
    byCompany.set(company, [...(byCompany.get(company) ?? []), { slip: s, payment }]);
  }
  for (const [company, asked] of byCompany) {
    const mine = asked.map(a => a.slip);
    let recorded: boolean[] | null;
    try {
      recorded = await reader!.recorded(indexer!, company, asked.map(a => a.payment));
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

/** Company addresses as a receipt names them: lower case, no `0x`, and nothing that is not one. */
const openedAddresses = (list: Iterable<string | null>): Set<string> => {
  const out = new Set<string>();
  for (const a of list) {
    const tidy = typeof a === 'string' ? tidyCompanyAddress(a) : null;
    if (tidy !== null) out.add(tidy);
  }
  return out;
};

const confirmedSafely = (confirmed: (slip: OpenedPayslip) => boolean, s: OpenedPayslip): boolean => {
  try { return confirmed(s) === true; } catch { return false; }
};

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

/**
 * **THE LIST AN OLDER PAYSLIPS PAGE KEPT IN THIS BROWSER, FOR NOBODY IN
 * PARTICULAR.** It is read once, into the saved keys of whoever opens theirs
 * here first, and then marked as taken. It is never emptied: what it holds is
 * left exactly as that page wrote it.
 */
const OLDER_LIST = 'payslip-companies';
const OLDER_LIST_TAKEN = 'payslip-companies-taken';

/** What the older list holds, or nothing once it has been taken. */
export function olderListNotYetTaken(
  storage: Pick<Storage, 'getItem'> | null = safeStorage(),
): string[] {
  try {
    if (storage === null || (storage.getItem(OLDER_LIST_TAKEN) ?? null) !== null) return [];
    const raw = storage.getItem(OLDER_LIST);
    return onlyCompanyAddresses(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

/** Marks the older list as taken, so it is read no more. The list itself is left alone. */
export function markOlderListTaken(
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  try { storage?.setItem(OLDER_LIST_TAKEN, '1'); } catch { /* not marked, so it is read again at the next unlock here */ }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
