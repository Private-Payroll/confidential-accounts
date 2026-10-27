import type { Hex } from '../../../src/core/crypto.js';
import {
  openPayslip, NOT_YOUR_PAYSLIP,
  type SealedPayslip, type OpenedPayslip,
} from '../../../src/core/payslip-open.js';
import type { WrappingKeypair } from '../../../src/core/crypto.js';
import type { WalletIndexer } from 'midnight-identity/profile/unlock';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { ChainReader, PayslipPayment } from './payslip-worker-client.js';
import { assets, ledgerTokenOf, type AssetRegistry } from '../../../src/core/assets.js';
import { paidPublicly } from './public-payment.js';
import { PAGE_OUT_OF_DATE, PAYSLIP_PAGE_HEADER, PAYSLIP_PAGE_VERSION } from '../../../src/core/payslip-page.js';

/**
 * **A PAYEE'S OWN PAYSLIPS, FETCHED AS CIPHERTEXT AND OPENED ON THIS DEVICE.**
 *
 * The page asks for every slip of one company's month, and tries each with the
 * secret in `keys`. Neither the secret nor its public half is ever part of a
 * request, and no slip the service holds says whose it is, so the service
 * never learns which slip is this person's.
 *
 * The requests carry this page's sign-in, because the service answers a
 * signed-in person only, and they name this page so that a page older than the
 * service is told to reload rather than to sign in again. While it answers, the
 * service therefore sees which signed-in person asks about which company and
 * month; it does not write that down.
 */
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

/** Thrown when the service says this page is older than it. Never caught as one address's failure. */
class PageOutOfDate extends Error {
  constructor() { super(PAGE_OUT_OF_DATE); this.name = 'PageOutOfDate'; }
}

const readJson = async (r: Response, doing: string): Promise<any> => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok && body?.code === 'payslip-page-out-of-date') throw new PageOutOfDate();
  if (!r.ok) throw new Error(body?.error ?? `${doing} failed (${r.status})`);
  return body;
};

interface MyPayslips {
  opened: OpenedPayslip[];
  /** What the service sent, still sealed. */
  sealed: SealedPayslip[];
  /** Slips of the month that this key did not open: everybody else's. */
  unopened: number;
  /**
   * Slips that opened but name a company other than the one this key was
   * worked out from. The key was handed to that one company only, so a slip
   * naming another was put there by a company this person never accepted, and
   * it is not shown.
   */
  refused: number;
}

/**
 * @param from the label of the company `keys` was worked out from. That
 *   company's slips are asked for, and only the ones that open with `keys` and
 *   name exactly that label inside their seal are shown.
 * @param period the month asked about, written YYYY-MM.
 */
export async function fetchMyPayslips(
  keys: WrappingKeypair, from: string, period: string, fetcher: Fetch = fetch,
): Promise<MyPayslips> {
  const address = readCompanyLabel(from);
  if (address === null) throw new Error('that is not a company\'s label, so no payslips were asked for.');
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/u.test(period)) throw new Error('that is not a month written YYYY-MM, so no payslips were asked for.');
  const sealed: SealedPayslip[] = await readJson(
    await fetcher(`/api/payslips?company=${encodeURIComponent(address)}&period=${encodeURIComponent(period)}`, asThisPage()),
    'fetching the company\'s payslips');
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
    if (slip.issuedBy !== address) { refused += 1; continue; }
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
 * and only when it is an account this page's wallet read the company's label
 * off, and the receipt names that same label.
 * `'paid'` only when the account's public set of completed payments was
 * read and holds this payment; `'not-yet'` only when it was read, does not
 * hold it, and the window this payment can still be made in has not closed;
 * `'cannot-tell'` whenever the wallet did not confirm the address, whenever the
 * receipt names a contract this page did not open for that company, whenever it
 * was not read, whatever the reason, and when the window has closed or was
 * never known. Nothing that failed is ever reported as not paid, and nothing
 * here asks this application's service.
 */
type OnTheChain = 'paid' | 'not-yet' | 'cannot-tell';

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
 * **ONLY AN ACCOUNT THE PAYEE'S WALLET READ THE COMPANY'S LABEL OFF IS
 * READ.** A receipt is sealed by the service, so the contract it names is the
 * service's word. So a receipt is asked about only when the contract it names
 * is one of `openedFor` - the accounts the payee's wallet read the company's
 * label off, itself, before it gave the key these slips opened with - and the
 * label the receipt names is the label the slip was opened for. A receipt alone
 * therefore cannot send this page to a contract the service deployed for
 * itself, nor to another company's account. Any other receipt reads "cannot
 * tell", and that is not a failure to read.
 *
 * @param openedFor the accounts the payee's wallet read the company's label
 *   off. Left out, nothing is read: a slip names a label, and a label locates
 *   no contract.
 */
async function readTheChain(
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
  const opened = openedAddresses(openedFor ?? []);
  const byCompany = new Map<string, { slip: OpenedPayslip; payment: PayslipPayment }[]>();
  for (const s of slips) {
    if (!s.receipt) continue;
    const company = s.receipt.company;
    /* A contract this page did not open for the company is never read, whatever else is known,
     * and nor is one the receipt says belongs to a company other than the one the slip names. */
    if (company === null || !opened.has(company)
      || s.receipt.label === null || s.receipt.label !== (s.issuedBy ?? null)) {
      out.set(s.runId, 'cannot-tell'); continue;
    }
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

/** Account addresses as a receipt names them: lower case, and nothing that is not one. */
const openedAddresses = (list: Iterable<string | null>): Set<string> => {
  const out = new Set<string>();
  for (const a of list) {
    const tidy = readAccountAddress(a);
    if (tidy !== null) out.add(tidy);
  }
  return out;
};

const confirmedSafely = (confirmed: (slip: OpenedPayslip) => boolean, s: OpenedPayslip): boolean => {
  try { return confirmed(s) === true; } catch { return false; }
};

/**
 * A company's label with the account the service says carries it now. The account is the service's
 * word, and the payee's wallet reads the label back off it before it gives
 * anything; one that does not carry the label is refused there.
 */
export async function payslipAddressesFor(
  company: string, fetcher: Fetch = fetch,
): Promise<Array<{ label: CompanyLabel; account: AccountAddress | null }>> {
  const r = await fetcher(
    `/api/payslips/addresses?company=${encodeURIComponent(company)}`,
    asThisPage());
  const body = await readJson(r, 'asking which account carries a company\'s label');
  const out: Array<{ label: CompanyLabel; account: AccountAddress | null }> = [];
  for (const c of Array.isArray(body.companies) ? body.companies : []) {
    const label = readCompanyLabel(c?.label);
    if (label === null) continue;
    out.push({ label, account: readAccountAddress(c?.account) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* which companies pay you, as this browser holds them for one person   */
/* ------------------------------------------------------------------ */

/**
 * **A LIST OF COMPANY LABELS, AND NOTHING ELSE, KEPT FOR ONE SIGNED-IN
 * PERSON.** The list that follows a person to every device is inside their own
 * saved keys (`keyring.ts`), which only their wallet changes. This one holds,
 * in this browser only, a label that is not saved there. It is keyed by the
 * person, so somebody else signing in in this browser is never shown it.
 * Labels are public on the companies' accounts, and nothing here opens
 * anything. A list written when companies were named by their accounts'
 * addresses holds no labels, and reads as empty: those companies are gone.
 */
const REMEMBERED = 'payslip-companies-of:';

/** Only well-formed company labels, each once. */
export const onlyCompanyLabels = (list: unknown): CompanyLabel[] =>
  Array.isArray(list)
    ? [...new Set(list.map((a) => readCompanyLabel(a)).filter((a): a is CompanyLabel => a !== null))]
    : [];

export function rememberedCompanies(
  person: string, storage: Pick<Storage, 'getItem'> | null = safeStorage(),
): string[] {
  try {
    const raw = storage?.getItem(REMEMBERED + person);
    return onlyCompanyLabels(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
