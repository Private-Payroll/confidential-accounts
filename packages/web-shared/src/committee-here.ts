/**
 * **WHO THE COMPANY'S SUPER ADMINS ARE, AND WHICH OF ITS CONTRACTS DO NOT YET
 * HOLD THEM, READ ON THIS DEVICE FROM THE CHAIN.**
 *
 * The super admins are the company's maintenance committee: the keys that may
 * change any contract the company has made, at their own threshold. The
 * account's maintenance authority, read at the indexer the person's own wallet
 * names, is the one source of who they are, and every vault must hold the same
 * keys, in the same order, at the same threshold. A contract that does not is
 * behind, and a company with any contract behind is half changed.
 *
 * The contracts are the account, every vault its state lists as adopted or
 * retired, and every vault the company's own records say it created. A vault's
 * own claim to belong to the account is never read as proof that it does.
 * Nothing here reads the company's service, a signer's role, the signers'
 * threshold, a vault's approval bar or a band: none of them sets or floors who
 * the super admins are or how many of them must agree. A device is a super
 * admin when its own wallet key is on that committee; a seat this device
 * believes is named beside a key only where its entry's opening proves that
 * key, for display, and a key no seat proves is a super admin all the same.
 *
 * Runs where the ledger's reader runs (the vault worker, or a test): `deps`
 * hands in the runtime's state reader and the account's compiled reader.
 */
import { authorityIn, type ContractAuthority } from 'midnight-identity/profile/contract-authority';
import { whyNotInstallable } from 'midnight-identity/profile/request';
import { sameCommittee } from '../../../src/midnight/vault-committee.js';
import type { DirectorySeat } from '../../../src/midnight/seat-directory.js';
import type { VaultChainSource } from './vault-on-chain-here.js';

/**
 * **A CHANGE OF THE SUPER ADMINS IN PROGRESS**: the committee it installs on
 * every contract, in its signed order with each key's kind, its threshold, and
 * each contract it moves with the counter it moves from, as the super admins'
 * own proposal names them, never as the service says.
 */
export interface SuperAdminChangeInProgress {
  readonly committee: ReadonlyArray<{ readonly tag: string; readonly value: string }>;
  readonly threshold: number;
  readonly contracts: ReadonlyArray<{ readonly address: string; readonly counter: bigint }>;
}

/** Where a contract of the company was found: on the account as adopted or retired, or in the company's own records. */
type FoundBy = 'adopted' | 'retired' | 'created by the company';

/** The super admins as the chain shows them, and every contract the company has made. */
export interface SuperAdminsHere {
  readonly account: string;
  /** Their keys in the chain's order, their threshold, and the account's counter. */
  readonly superAdmins: ContractAuthority;
  /** Why the account's committee is not one `committeeInstallRefusals` allows, or null when it is. */
  readonly refused: string | null;
  readonly inProgress: SuperAdminChangeInProgress | null;
  /**
   * The account first, then every vault, each once: where it was found (empty
   * for the account), who holds it now or why the chain could not show it, and
   * whether it holds exactly the committee it must hold now - the change in
   * progress's, or else the account's.
   */
  readonly contracts: ReadonlyArray<{
    readonly contract: 'account' | 'vault';
    readonly address: string;
    readonly foundBy: ReadonlyArray<'adopted' | 'retired' | 'created by the company'>;
    readonly authority: ContractAuthority | null;
    readonly why: string | null;
    readonly current: boolean;
  }>;
  /** Every contract that is not current, by address: the company is half changed while any is listed. */
  readonly behind: readonly string[];
}

/** What this device reads with: the runtime's state reader and the account's compiled reader. */
interface ReadersHere {
  readonly runtimeState: { deserialize(bytes: Uint8Array): unknown };
  readonly accountLedger: (data: unknown) => unknown;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A contract's state at the wallet's indexer, deserialized, or null when the indexer holds none there. */
async function stateAt(deps: ReadersHere, chain: Pick<VaultChainSource, 'contractState'>, address: string): Promise<unknown | null> {
  const served = await chain.contractState(address);
  return served === null || served === undefined ? null : deps.runtimeState.deserialize(served.serialize());
}

/**
 * **THE SUPER ADMINS AND EVERY CONTRACT THE COMPANY HAS MADE, READ AT THE
 * INDEXER THE PERSON'S OWN WALLET NAMES (`chain`).** Returns the account's
 * committee and threshold as the super admins; every contract, each with its
 * own authority from the chain; and which of them are behind - not holding
 * `inProgress`'s committee while a change of the super admins is in progress,
 * or the account's otherwise. `createdByTheCompany` is every vault the
 * company's own records say it created, which the account lists only once it
 * is adopted. Throws, saying why, when the account is not on the chain at that
 * indexer or its authority or lists cannot be read: nothing is believed about
 * the super admins from anything else.
 */
export async function superAdminsHere(
  deps: { readonly runtimeState: { deserialize(bytes: Uint8Array): unknown }; readonly accountLedger: (data: unknown) => unknown },
  chain: Pick<VaultChainSource, 'contractState'>,
  input: {
    readonly account: string;
    readonly createdByTheCompany: readonly string[];
    readonly inProgress: SuperAdminChangeInProgress | null;
  },
): Promise<SuperAdminsHere> {
  const account = input.account.toLowerCase();
  if (!HEX64.test(account)) throw new Error('a company\'s account is named by its sixty-four character address, and this is not one. Name the account by its address as the page shows it.');
  const state = await stateAt(deps, chain, account);
  if (state === null) {
    throw new Error('the indexer your wallet names does not hold the company\'s account yet, so who its super admins are cannot '
      + 'be read. Wait for your wallet to catch up, then try again.');
  }
  const held = authorityIn(state);
  if ('why' in held) throw new Error(`who holds the company's account cannot be read, so its super admins are not known: ${held.why}`);
  const view = deps.accountLedger((state as { data: unknown }).data) as {
    vaults?: Iterable<Uint8Array>; retiredAt?: Iterable<[Uint8Array, unknown]>;
  } | null;
  if (view?.vaults === undefined || view.retiredAt === undefined) {
    throw new Error('the company\'s account does not list the vaults it adopted and retired, so its contracts cannot be found. '
      + 'Reload the page; if it happens again, contact support.');
  }
  const found = new Map<string, FoundBy[]>();
  const add = (address: string, by: FoundBy) => {
    const at = address.toLowerCase();
    if (at === account) return;
    found.set(at, [...(found.get(at) ?? []), by]);
  };
  for (const v of view.vaults) add(hexOf(v), 'adopted');
  for (const [v] of view.retiredAt) add(hexOf(v), 'retired');
  for (const v of input.createdByTheCompany) {
    if (!HEX64.test(v.toLowerCase())) {
      throw new Error(`the company's records name a vault by "${v}", which is not an address, so the records are damaged. Reload the page.`);
    }
    add(v, 'created by the company');
  }

  const must = input.inProgress === null
    ? { committee: held.committee, threshold: held.threshold }
    : { committee: input.inProgress.committee, threshold: input.inProgress.threshold };
  const isCurrent = (a: ContractAuthority): boolean => sameCommittee({ committee: a.committee, threshold: a.threshold }, must);

  const contracts: Array<SuperAdminsHere['contracts'][number]> = [
    { contract: 'account', address: account, foundBy: [], authority: held, why: null, current: isCurrent(held) },
  ];
  for (const [address, foundBy] of found) {
    const vault = await stateAt(deps, chain, address);
    const read = vault === null ? { why: 'the indexer your wallet names holds no contract at this address.' } : authorityIn(vault);
    contracts.push('why' in read
      ? { contract: 'vault', address, foundBy, authority: null, why: read.why, current: false }
      : { contract: 'vault', address, foundBy, authority: read, why: null, current: isCurrent(read) });
  }
  return {
    account,
    superAdmins: held,
    refused: whyNotInstallable(held),
    inProgress: input.inProgress,
    contracts,
    behind: contracts.filter((c) => !c.current).map((c) => c.address),
  };
}

/**
 * **WHO HOLDS ONE CONTRACT NOW, READ AT THE INDEXER THE PERSON'S OWN WALLET
 * NAMES**: its committee, threshold and counter, or null when that indexer
 * holds no contract there or its authority cannot be read. A send is judged by
 * this read and never by what the service says it did.
 */
export async function authorityHere(
  deps: ReadersHere, chain: Pick<VaultChainSource, 'contractState'>, address: string,
): Promise<ContractAuthority | null> {
  const state = await stateAt(deps, chain, address.toLowerCase());
  if (state === null) return null;
  const read = authorityIn(state);
  return 'why' in read ? null : read;
}

/** One super admin as a device shows it: the key the chain's committee holds, and the seat it is named by where one is. */
export interface SuperAdminShown {
  readonly key: { readonly tag: string; readonly value: string };
  /** The believed seat whose entry's opening proves this key, for display only; null where no seat proves it. */
  readonly seat: { readonly seat: string; readonly person: string } | null;
  /** Whether the key is this device's own wallet key. */
  readonly mine: boolean;
}

const sameKey = (a: { readonly tag: string; readonly value: string }, b: { readonly tag: string; readonly value: string }): boolean =>
  a.tag === b.tag && a.value.toLowerCase() === b.value.toLowerCase();

/**
 * **EVERY SUPER ADMIN, AS A DEVICE SHOWS THEM, AND WHETHER THIS DEVICE IS ONE.**
 * Returns each key of the committee as the chain holds it (`superAdmins`, read
 * by `superAdminsHere` at the indexer the person's own wallet names), in the
 * chain's order, each a full super admin; beside each, the seat this device
 * believes whose entry's opening proved that key, where one did, for display
 * alone. A key no seat proves is shown by its key and flagged for nothing: the
 * company's super admins may hold keys no signer holds. This device is a super
 * admin exactly when `ownWalletKey`, its own wallet's key, is on that
 * committee: no seat, role or signer is asked.
 */
export function superAdminsShown(
  superAdmins: Pick<ContractAuthority, 'committee'>,
  seats: readonly Pick<DirectorySeat, 'seat' | 'person' | 'committeeKey'>[],
  ownWalletKey: { readonly tag: string; readonly value: string } | null,
): { readonly shown: readonly SuperAdminShown[]; readonly iAmOne: boolean } {
  const shown = superAdmins.committee.map((key) => {
    const proved = seats.find((x) => x.committeeKey !== undefined && sameKey(x.committeeKey, key));
    return {
      key: { tag: key.tag, value: key.value },
      seat: proved === undefined ? null : { seat: proved.seat, person: proved.person },
      mine: ownWalletKey !== null && sameKey(ownWalletKey, key),
    };
  });
  return { shown, iAmOne: shown.some((x) => x.mine) };
}

/** Said on every device while the account's committee holds one key: never a refusal, the company's own choice. */
export const ONE_SUPER_ADMIN_LEFT = 'only one super admin\'s key holds the company\'s contracts. If that key is lost, '
  + 'nobody can ever change who holds them again. Add another super admin while you can.';

/** Said on every device while the account's committee needs every one of its keys: never a refusal, the company's own choice. */
export const EVERY_SUPER_ADMIN_NEEDED = 'every super admin\'s key is needed to change who holds the company\'s contracts. If any one '
  + 'of them is lost, nobody can ever change who holds them again. Add another super admin, or need fewer of them, while you can.';

/**
 * **WHAT A DEVICE SAYS OF A COMMITTEE THAT ONE LOST KEY WOULD STRAND**:
 * `ONE_SUPER_ADMIN_LEFT` for a lone key, `EVERY_SUPER_ADMIN_NEEDED` where its
 * threshold is its size, or null. Never a refusal.
 */
export function committeeWarning(c: { readonly committee: readonly unknown[]; readonly threshold: number }): string | null {
  if (c.committee.length === 1) return ONE_SUPER_ADMIN_LEFT;
  return c.committee.length > 1 && c.threshold >= c.committee.length ? EVERY_SUPER_ADMIN_NEEDED : null;
}

/** The super admins and the company's contracts as a device shows them: `superAdminsHere`, each key shown, and the warning. */
export interface SuperAdminsSeen extends SuperAdminsHere {
  readonly shown: readonly SuperAdminShown[];
  readonly iAmOne: boolean;
  /** `committeeWarning` of the account's committee: one key left, or every key needed; or null. */
  readonly warning: string | null;
}

/**
 * **WHAT EVERY DEVICE SHOWS OF THE SUPER ADMINS**: `superAdminsHere` read at
 * the indexer the person's own wallet names, every committee key shown as a
 * super admin (`superAdminsShown`) with the believed seat whose opening proves
 * it where there is one, which contracts are behind, and a warning when one
 * lost key would strand the committee (`committeeWarning`). Nothing here refuses: a key no seat proves, or a lone key, is
 * shown as it is.
 */
export async function superAdminsSeenHere(
  deps: ReadersHere,
  chain: Pick<VaultChainSource, 'contractState'>,
  input: Parameters<typeof superAdminsHere>[2] & {
    readonly seats: Parameters<typeof superAdminsShown>[1];
    readonly ownWalletKey: { readonly tag: string; readonly value: string } | null;
  },
): Promise<SuperAdminsSeen> {
  const here = await superAdminsHere(deps, chain, input);
  const { shown, iAmOne } = superAdminsShown(here.superAdmins, input.seats, input.ownWalletKey);
  return { ...here, shown, iAmOne, warning: committeeWarning(here.superAdmins) };
}
