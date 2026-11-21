/**
 * **THE COMPANY'S VIEW AS THIS PAGE OPENS IT.** A screen that shows a company opens one view of it and every tile,
 * hook and action of that opening reads through it: the company's service through the page's one transport, and who
 * holds the company through the person's own wallet, asked once for the view (and once more, fresh, by the check
 * before a write). The same wallet answer names the indexer the wallet reads the chain through, which the view's
 * chain reads use; the wallet is never asked a second time for it. The account's roles are asked of the same wallet
 * when a read needs them, once for each set asked.
 *
 * A view on the page lasts one opening of a screen: the screen that opens it ends it when it shows something else,
 * when the wallet releases the company's key, when an action in the person's wallet has run on the company and when
 * the sign-in ends or changes (company-reads-stale.ts). A read no screen makes (the list of the person's companies)
 * opens its own and ends it when the read is done. This file keeps no view: whoever opens one holds it and hands it
 * to what reads through it. The company's keys a view opened are kept by the view alone and go with it.
 *
 * A company that is being created has no account on the chain yet and nothing sealed to members: it is read through
 * `sourceOnPage` alone, with no view.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { WalletIndexer } from 'midnight-identity/profile/unlock';
import { anchorHeadsKept } from './builder-answers-kept.js';
import { companyViewFor, type HeldReader } from './company-view.js';
import { once } from './company-view-doors.js';
import type { JudgeView } from './company-view-judges.js';
import { anchorsOnChainAt } from './records-anchored-here.js';
import { serviceSource, type RecordSource } from './records-source.js';
import { serviceCall } from './service-transport.js';
import { treeKeptHere } from './tree-kept-here.js';
import type { DirectoryBelieved } from './vault-page-doors.js';
import type { VaultBuilderClient, VaultOnChainOnTheWire } from './vault-worker-client.js';
import { vaultsReadInTheView, type VaultsReadOnce } from './vaults-read-in-the-view.js';
import type { Hex } from '../../../src/core/crypto.js';
import { holdersFromTheWallet } from './wallet-asks.js';

/** Where a company is on the chain: its label and the account that carries it. */
export interface OnTheChain { readonly company: CompanyLabel; readonly account: AccountAddress }

/** What the page hands in to open its views: its wallet, its builder, and how a view of a company on the chain reads held. */
export interface PageDoors {
  readonly walletOrigin: string;
  readonly builder: () => Promise<VaultBuilderClient>;
  readonly held: (view: JudgeView, where: OnTheChain) => HeldReader;
  /** The company's directory with its records, as this page's seat believes it over `view`. */
  readonly directory: (view: JudgeView) => Promise<DirectoryBelieved>;
}

/** The company has no account on the chain yet, so nothing of it is read through a view. */
export class NotOnTheChainYet extends Error {
  constructor() {
    super('this company has no account on the chain yet, so who holds it cannot be read and nothing of it is believed here.');
    this.name = 'NotOnTheChainYet';
  }
}

/**
 * What the page keeps beside one view: the account it found the company's place on the chain in, the wallet's indexer,
 * the view's reads of the vaults on the chain, one for each round the person asked them read again, and how many
 * rounds the view has handed out.
 */
interface Beside {
  readonly account: () => Promise<unknown>;
  readonly where: () => Promise<OnTheChain | null>;
  indexer: WalletIndexer | null;
  readonly readsByRound: Map<number, VaultsReadOnce>;
  rounds: number;
  readonly builder: Pick<VaultBuilderClient, 'vaultsOnChain'>;
}
const beside = new WeakMap<JudgeView, Beside>();

/** The company's records as its service keeps them, asked through the page's one transport. */
export const sourceOnPage = (companyId: string): RecordSource => serviceSource(serviceCall, companyId);

/**
 * The source a view reads, with the account read shared between the view and its wallet door: the door reads the
 * account to find the company on the chain before it can ask who holds it, and the view's own first read of the
 * account is that same request. A write forgets it, so the view reads the account afresh after one.
 */
const sharingTheAccount = (source: RecordSource): { readonly source: RecordSource; readonly account: () => Promise<unknown> } => {
  let first: Promise<unknown> | null = null;
  const account = (): Promise<unknown> => {
    if (first !== null) return first;
    const read = source.account();
    first = read;
    read.catch(() => { if (first === read) first = null; });
    return read;
  };
  return { account, source: Object.freeze<RecordSource>({ ...source, account, write: (w) => { first = null; return source.write(w); } }) };
};

const whereIn = (sealed: unknown): OnTheChain | null => {
  const s = (sealed ?? {}) as { readonly companyLabel?: unknown; readonly contractAddress?: unknown };
  const { companyLabel: company, contractAddress: account } = s;
  return typeof company !== 'string' || typeof account !== 'string' ? null : { company: company as CompanyLabel, account: account as AccountAddress };
};

/**
 * A new view of `companyId` for one opening of a screen, or for one read no screen makes. Whoever opens it holds it,
 * hands it to everything that reads through it, and ends it.
 */
export const openOnPage = (companyId: string, doors: PageDoors): JudgeView => {
  const { source, account } = sharingTheAccount(sourceOnPage(companyId));
  const where = once(async () => whereIn(await account()));
  const there = async (): Promise<OnTheChain> => {
    const at = await where();
    if (at === null) throw new NotOnTheChainYet();
    return at;
  };
  const builder = { vaultsOnChain: async (ask: Parameters<VaultBuilderClient['vaultsOnChain']>[0]) => (await doors.builder()).vaultsOnChain(ask) };
  const kept: Beside = { account, where, indexer: null, readsByRound: new Map(), rounds: 0, builder };
  const made: JudgeView = companyViewFor(source, {
    holders: async () => {
      const read = await holdersFromTheWallet(doors.walletOrigin, await there());
      kept.indexer = read.indexer;
      return read.holders;
    },
    onChain: async () => {
      const at = await there();
      await made.holders();
      return anchorsOnChainAt(await doors.builder(), at.account, kept.indexer);
    },
    builder: { anchorHeads: async (ask) => anchorHeadsKept(await doors.builder())(ask) },
    /* The account's roles asked, as the same wallet reads them off the chain; the view keeps each answer for the set asked. */
    roles: async (asked) => ({ roles: (await holdersFromTheWallet(doors.walletOrigin, { ...(await there()), roles: asked })).roles }),
    kept: () => treeKeptHere(),
    directory: (view) => doors.directory(view),
  }, async (inner, asked) => doors.held(made, await there())(inner, asked));
  beside.set(made, kept);
  return made;
};

const besideOf = (view: JudgeView): Beside => {
  const kept = beside.get(view);
  if (kept === undefined) throw new Error('this read of the company was not opened by this page, so the page reads nothing beside it.');
  return kept;
};

/**
 * The company's account as the service keeps it, read once for the view: the read its wallet door finds the company on
 * the chain with. It does not wait for the view's first read, so a company with no account on the chain yet, which
 * no view reads, can still be told apart here.
 */
export const accountOnPage = (view: JudgeView): Promise<unknown> => {
  if (view.ended !== null) return view.account();
  return besideOf(view).account();
};

/** Where the view's company is on the chain, or null while it has no account there. */
export const onTheChain = (view: JudgeView): Promise<OnTheChain | null> => besideOf(view).where();

/**
 * The indexer the person's wallet named when the view asked it who holds the company: the one place this page reads
 * the chain from for the company. Null when the wallet named none.
 */
export const indexerOnPage = async (view: JudgeView): Promise<WalletIndexer | null> => {
  await view.holders();
  return besideOf(view).indexer;
};

/**
 * **A VAULT ON THE CHAIN, READ THROUGH THE VIEW.** Every vault the company's account adopted, as the view's holders name
 * them, is read with the first vault asked, in one `vaultsOnChain` ask at `indexer`, and each answer is kept in the
 * view for every tile of the opening (`vaultsReadInTheView`). `round` is 0, or a round the view handed out for a press
 * to read the vaults again (`vaultRoundOnPage`): each round reads the chain afresh, once for every tile asking in it.
 */
export const vaultOnPage = async (view: JudgeView, vault: string, indexer: WalletIndexer, round = 0): Promise<VaultOnChainOnTheWire> => {
  const kept = besideOf(view);
  let reads = kept.readsByRound.get(round);
  if (reads === undefined) {
    const inRound: () => Pick<JudgeView, 'layer'> = round === 0 ? () => view
      : () => ({ layer: (name, build) => view.layer(`${name}:again-${round}`, build) });
    reads = vaultsReadInTheView(inRound, kept.builder);
    kept.readsByRound.set(round, reads);
  }
  reads.declare((await view.holders()).adoptedVaults);
  return reads.read(vault as Hex, indexer);
};

/**
 * A new round of reading the vaults again, for one press of the person's: handed out by the view, so no two presses in
 * one opening share a round, however often the screen that asks is drawn again.
 */
export const vaultRoundOnPage = (view: JudgeView): number => {
  const kept = besideOf(view);
  kept.rounds += 1;
  return kept.rounds;
};
