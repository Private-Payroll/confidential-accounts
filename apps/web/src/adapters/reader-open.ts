/**
 * **A READER OPENS A COMPANY: ASKS ITS WALLET, THEN READS WITH WHAT THE WALLET GAVE.** The wallet answers with the read
 * keys its reader's grant in force names for this company, or with nothing and the words it refused in. What the page
 * keeps of that is the keys held for the visit by `readerKeysFromTheWallet` and nothing else: a refusal drops them, so
 * the next read opens nothing. A refusal is told by its code, in the page's own phrases, and is remembered for the sign-up
 * page the reader is sent back to, so the reason is there when they arrive.
 */
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import { readerKeysFromTheWallet, readerKeysReleasedFor } from 'vaults-web-shared/reader-keys-released.js';
import { keyringFor } from './keyring-person.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';
import { READER_OF, READER_REFUSED, readReaderCompany, type ReaderCompany, type ReaderLink } from './reader-records.js';

/** Why a reader's company did not open, by the code the wallet or the read gave; each has its own phrase on the page. */
export const READER_WHY = {
  noGrant: 'no-grant', takenAway: 'taken-away', notAReaderHere: 'not-a-reader-here', notRead: 'not-read', notOnChain: 'not-on-chain', notACompany: 'not-a-company',
  unreached: 'unreached', notTheCompanys: 'not-the-companys', noKeys: 'no-keys', other: 'other',
} as const;
export type ReaderWhy = (typeof READER_WHY)[keyof typeof READER_WHY];

const FROM_THE_WALLET: Readonly<Record<string, ReaderWhy>> = {
  'no-grant': READER_WHY.noGrant, 'taken-away': READER_WHY.takenAway, 'not-a-reader-here': READER_WHY.notAReaderHere, 'not-read': READER_WHY.notRead,
  'not-on-chain': READER_WHY.notOnChain, 'not-a-company': READER_WHY.notACompany, 'service-unreached': READER_WHY.unreached,
};

/** The code at the end of the key of the words the wallet refused in (`act.reader-keys.why.no-grant`), as the page tells it; other when the wallet named none it knows. */
export const readerWhyOf = (refused: string | null): ReaderWhy => FROM_THE_WALLET[/^act\.[a-z-]+\.why\.([a-z-]+)$/u.exec(refused ?? '')?.[1] ?? ''] ?? READER_WHY.other;

/** Whether the wallet gave the reader's keys, or the company stayed closed; compared by the code. */
export const READER_KEYS = { held: 'held', closed: 'closed' } as const;

export type ReaderOpened =
  | { readonly of: typeof READER_OF.open; readonly company: Extract<ReaderCompany, { readonly of: typeof READER_OF.open }> }
  | { readonly of: typeof READER_KEYS.closed; readonly why: ReaderWhy }
  | { readonly of: typeof ACTED.refused; readonly why: ActRefusal };

/** The reader's link as its address carries it, read in the closed shapes a label and an address have; null for anything else. */
export function readerLinkOf(params: Readonly<Record<string, string>>): ReaderLink | null {
  const label = readCompanyLabel(params.label);
  const account = readAccountAddress(params.account);
  return label === null || account === null || (params.id ?? '') === '' ? null : { id: params.id!, label, account };
}

/** The reason a company did not open, kept for the sign-up page of the same company the reader is sent back to. */
const closed = new Map<string, ReaderOpened>();

/** Keeps `opened` for the sign-up page of `id` when it is not an open company, and forgets what was kept when it is. */
export function rememberWhyNotOpen(id: string, opened: ReaderOpened): void {
  if (opened.of === READER_OF.open) closed.delete(id); else closed.set(id, opened);
}

/** What was kept for `id`, once. */
export function takeWhyNotOpen(id: string): Exclude<ReaderOpened, { readonly of: typeof READER_OF.open }> | null {
  const kept = closed.get(id) ?? null;
  closed.delete(id);
  return kept === null || kept.of === READER_OF.open ? null : kept;
}

/** Reads the company with the keys this visit holds for it, without asking the wallet; closed when it holds none. */
export async function readOpened(link: ReaderLink): Promise<ReaderOpened> {
  const held = readerKeysReleasedFor(link.id);
  if (held === null) return { of: READER_KEYS.closed, why: READER_WHY.noKeys };
  const read = await readReaderCompany(held, link);
  if (read.of === READER_OF.open) return { of: READER_OF.open, company: read };
  return { of: READER_KEYS.closed, why: read.why === READER_REFUSED.notTheCompanys ? READER_WHY.notTheCompanys : READER_WHY.unreached };
}

/** Asks the wallet for the reader's keys for the company: nothing held and the reason when it gave none, which drops any keys held before. */
export async function askForReaderKeys(personId: string, link: ReaderLink): Promise<{ readonly of: typeof READER_KEYS.held } | Exclude<ReaderOpened, { readonly of: typeof READER_OF.open }>> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp };
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    const asked = await readerKeysFromTheWallet({ accountId: link.id, label: link.label, account: link.account }, ACCOUNT_ORIGIN);
    return asked.of === READER_KEYS.held ? { of: READER_KEYS.held } : { of: READER_KEYS.closed, why: readerWhyOf(asked.refused) };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}

/** Asks the wallet, then reads: the whole of opening a company as a reader. */
export async function openAsReader(personId: string, link: ReaderLink): Promise<ReaderOpened> {
  const asked = await askForReaderKeys(personId, link);
  return asked.of === READER_KEYS.held ? readOpened(link) : asked;
}
