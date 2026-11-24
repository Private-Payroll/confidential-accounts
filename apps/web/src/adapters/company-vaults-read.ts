import type { SealedAccount } from '../../../../src/core/types.js';
import { companyKeysQuietlyFor, filingJudgeFor, openedQuietly, sealedIn, storeReachIn, vaultOnChainIn, walletIndexerIn, type PageView } from './filing-judge.js';
import { VAULT, type VaultStanding } from 'vaults-web-shared/vault-standing.js';
import type { CompanyKeys } from '../../../../src/core/company-key.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { keyringFor, keysOnTheWayIn } from './keyring-person.js';
import { vaultPublicMoney, type VaultPublicMoney } from './vault-public-money.js';
import { READ, type Read } from './reads.js';
import { LIST, PROVEN } from './view-asks.js';
import { type ChainSeats } from './signers.js';
import type { VaultRow } from './company-rows.js';
import { VAULT_INFO_KIND } from '../../../../src/midnight/vault-info-record.js';

/*
 * THE VAULTS OF A COMPANY, THEIR PUBLIC MONEY AND THEIR NAMES, READ ON THIS DEVICE.
 *
 * The vaults the company's account has adopted come from the person's own wallet, each with the service's row for it
 * and how many signers must approve it. A vault's public money is read in this device's vault worker, and the name the
 * company filed for a vault is opened with the company's key and believed only as far as the company's directory
 * believes the filer. Whatever cannot be read is handed on as not read, never as empty or as unnamed.
 */

const VAULT_STANDINGS: readonly string[] = Object.values(VAULT);

/** A vault for a screen; a standing the service names that is not one of the set is unknown. `adopted` when the account adopted it. */
const vaultRow = (v: { vault: string; deployedAt: string; state: string }, adopted = false): VaultRow => ({
  vault: v.vault, createdAt: v.deployedAt, standing: (VAULT_STANDINGS.includes(v.state) ? v.state : VAULT.unknown) as VaultStanding,
  ...(adopted ? { adopted: true as const } : {}),
});

/** A vault sent and not yet adopted: its set-up is not finished, so it is not yet one of the company's vaults. */
const NOT_YET_ADOPTED: ReadonlySet<string> = new Set([VAULT.startOwed, VAULT.notOnChain]);

/** A row of the service's list of a company's vaults, as it answers it. */
type ServedVault = { vault: string; deployedAt: string; state: string };

/** What the chain holds of the approvals: the company's, and the vaults that have a number of their own. */
interface VaultNumbers { readonly company: number | null; readonly own: readonly { readonly vault: string; readonly threshold: number }[] }

const wholeApprovals = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;

/** The approvals a vault's runs need: its own number where the chain gives it one, else the company's; null where that is not a whole number of one or more. */
const approvalsOfVault = (numbers: VaultNumbers, vault: string): number | null => {
  const own = numbers.own.find((v) => v.vault.toLowerCase() === vault.toLowerCase());
  const n = own === undefined ? numbers.company : own.threshold;
  return wholeApprovals(n) ? n : null;
};

/**
 * **THE COMPANY'S VAULTS ARE THE VAULTS ITS ACCOUNT HAS ADOPTED, AS THE
 * PERSON'S OWN WALLET READ THEM OFF THE CHAIN.** The service's list only
 * says when each was made and where its set-up stands. A vault the account
 * adopted that the service's list leaves out makes the whole list unreadable,
 * so a list cut short is noticed rather than shown short; a vault the service
 * lists that the account has not adopted is shown only as a set-up not
 * finished, never as one of the company's vaults. Each row of a vault the
 * account adopted says so, so a screen reads a name only for those, and carries the approvals that vault's runs need where the
 * chain gave them (a vault not yet adopted has none).
 */
const vaultsAsTheChainHoldsThem = (
  served: readonly ServedVault[], adopted: readonly string[], numbers?: VaultNumbers, retired: ReadonlySet<string> = new Set(),
): Read<readonly VaultRow[]> => {
  const held = new Set(adopted.map((v) => v.toLowerCase()));
  const listed = new Set(served.map((r) => r.vault.toLowerCase()));
  if ([...held].some((v) => !listed.has(v))) return { of: READ.unreadable };
  return {
    of: READ.read,
    value: served.filter((r) => held.has(r.vault.toLowerCase()) || NOT_YET_ADOPTED.has(r.state) || retired.has(r.vault.toLowerCase())).map((r) => {
      if (!held.has(r.vault.toLowerCase()) && retired.has(r.vault.toLowerCase())) return { ...vaultRow(r), retired: true as const };
      const approvals = numbers === undefined || !held.has(r.vault.toLowerCase()) ? null : approvalsOfVault(numbers, r.vault);
      return { ...vaultRow(r, held.has(r.vault.toLowerCase())), ...(approvals === null ? {} : { approvals }) };
    }),
  };
};

/**
 * WHAT THE PERSON'S OWN WALLET READ OF THE COMPANY'S ACCOUNT WHEN THE VIEW ASKED IT, with the service's list of its vaults: the
 * vaults the account has adopted, each with the service's row for it, and how many signers must approve. The approvals
 * are the answer's `approvals`, never its `threshold`, which is the account's maintenance committee's. Each is
 * unreadable when the company names no account yet or the read it rests on fails; the approvals do not wait on the
 * service's list, and the vaults do not rest on a wallet answer that carries no approvals.
 */
export async function chainOfTheCompany(
  view: PageView, sealed: Pick<SealedAccount, 'companyLabel' | 'contractAddress'>,
): Promise<{ vaults: Read<readonly VaultRow[]>; approvals: Read<number>; holders: Read<ChainSeats>; retiredToo?: (retired: ReadonlySet<string>) => Read<readonly VaultRow[]> }> {
  const label = sealed.companyLabel ?? null;
  const address = sealed.contractAddress ?? null;
  if (label === null || address === null) return { vaults: { of: READ.unreadable }, approvals: { of: READ.unreadable }, holders: { of: READ.unreadable } };
  const [answer, holders] = await Promise.all([
    (view.list(LIST.vaults) as Promise<{ rows?: unknown } | null>).catch(() => null),
    view.holders().catch(() => null),
  ]);
  if (holders === null) return { vaults: { of: READ.unreadable }, approvals: { of: READ.unreadable }, holders: { of: READ.unreadable } };
  const needed = holders.approvals;
  const approvals: Read<number> = Number.isSafeInteger(needed) && needed >= 1 ? { of: READ.read, value: needed } : { of: READ.unreadable };
  const listed = (retired?: ReadonlySet<string>): Read<readonly VaultRow[]> => (Array.isArray(answer?.rows)
    ? vaultsAsTheChainHoldsThem(answer.rows as ServedVault[], holders.adoptedVaults, { company: approvals.of === READ.read ? approvals.value : null, own: holders.vaultThresholds ?? [] }, retired)
    : { of: READ.unreadable });
  return { vaults: listed(), approvals, holders: { of: READ.read, value: holders }, retiredToo: listed };
}

/**
 * The vaults of the company `view` reads, whose record is `sealed`: the account's own, as the person's own wallet read
 * them, each with the service's row for it; unreadable when the company names no account yet, or either read fails.
 */
export async function vaultListOf(view: PageView, sealed: Pick<SealedAccount, 'companyLabel' | 'contractAddress'>): Promise<Read<readonly VaultRow[]>> {
  return (await chainOfTheCompany(view, sealed)).vaults;
}

/**
 * WHAT THE VAULT `vault` HOLDS IN PUBLIC MONEY, read when the person asks: the
 * vault's state read in this device's vault worker, at the indexer this
 * person's own wallet names, through the view with every vault the account
 * adopted (`vaultOnChainIn`), afresh for each `round` the person asked it read
 * again, and read by the shared reader. Null when it could
 * not be read, the company names no account or label, or the wallet names no
 * indexer, which is never shown as nothing held.
 */
export async function readVaultPublicMoney(personId: string, view: PageView, vault: string, round = 0): Promise<VaultPublicMoney | null> {
  try {
    if (!(await keyringFor(personId))) return null;
    const sealed = await sealedIn(view);
    const label = sealed.companyLabel ?? null;
    const address = sealed.contractAddress ?? null;
    if (label === null || address === null) return null;
    const indexer = await walletIndexerIn(view);
    if (indexer === null) return null;
    return await vaultPublicMoney(() => vaultOnChainIn(view, vault, indexer, round));
  } catch {
    return null;
  }
}

/** What `readVaultName` answers, when asked to, for a name it could not read, apart from none filed. */
export const NAME_NOT_READ: unique symbol = Symbol();

/**
 * THE NAME THE COMPANY FILED FOR THE VAULT `vault`, opened on this device with the company's key and believed only
 * as far as the company's directory, read by the person's own wallet, believes the filer. Null when there is no name
 * to show: none was filed, it is blank, or - unless `unread` is given, which is answered instead - it could not be
 * read or believed, nobody or somebody else is signed in, or the company names no account. A screen then says the
 * vault by its number. The record code is loaded when a name is asked for, so a page that shows no name does not carry it.
 * The vault's name record is named to the view before anything is awaited, so the names asked in one turn are proven
 * together in one held read, however many vaults a screen draws.
 */
export async function readVaultName(personId: string, view: PageView, vault: string): Promise<string | null>;
export async function readVaultName(personId: string, view: PageView, vault: string, unread: typeof NAME_NOT_READ): Promise<string | null | typeof NAME_NOT_READ>;
export async function readVaultName(
  personId: string, view: PageView, vault: string, unread?: typeof NAME_NOT_READ,
): Promise<string | null | typeof NAME_NOT_READ> {
  const notRead = unread ?? null;
  view.declare({ records: [{ store: PROVEN.company, kind: VAULT_INFO_KIND, id: vault.toLowerCase() }] });
  try {
    if (!(await keyringFor(personId))) return notRead;
    const sealed = await sealedIn(view);
    const label = sealed.companyLabel ?? null;
    const address = sealed.contractAddress ?? null;
    if (label === null || address === null) return notRead;
    const keys = await keysOnTheWayIn(view.company);
    if (keys === null) return notRead;
    const account = await openedQuietly(view, sealed);
    if (account === null) return notRead;
    const companyKeys: CompanyKeys = await companyKeysQuietlyFor(view, sealed, { signingPublicKey: keys.signingPublicKey });
    const judge = filingJudgeFor(view, label as CompanyLabel, address as AccountAddress, companyKeys, async () => account);
    const { vaultInfoHere, vaultInfoRecordsFor } = await import('vaults-web-shared/vault-info-here.js');
    const records = vaultInfoRecordsFor(view.company, null, judge, storeReachIn(view));
    const filed = await vaultInfoHere({ companyKeys, records }, vault);
    if (filed.state === 'unread') return notRead;
    return filed.state === 'named' && filed.name.trim() !== '' ? filed.name : null;
  } catch {
    return notRead;
  }
}
