/**
 * **THE COMPANY'S VIEW AS THIS PAGE OPENS IT.** A screen that shows a company opens one view of it and every tile,
 * hook and action of that opening reads through it: the company's service through the page's one transport, and who
 * holds the company through the person's own wallet, asked once for the view (and once more, fresh, by the check
 * before a write). The same wallet answer names the indexer the wallet reads the chain through: the view's holders
 * carry it (`HoldersOnPage`), its chain reads use it, and the wallet is never asked a second time for it. The account's
 * roles are asked of the same wallet when a read needs them, once for each set asked.
 *
 * A view on the page lasts one opening of a screen: the screen that opens it ends it when it shows something else,
 * when the wallet releases the company's key, when an action in the person's wallet has run on the company and when
 * the sign-in ends or changes (company-reads-stale.ts). A read no screen makes (the list of the person's companies)
 * opens its own and ends it when the read is done. This file keeps no view: whoever opens one holds it and hands it
 * to what reads through it, and nothing about a view is kept beside it: the company's keys a view opened, its reads of
 * the vaults on the chain and its rounds of reading them again are kept by the view alone and go with it.
 *
 * A company that is being created has no account on the chain yet and nothing sealed to members: it is read through
 * `sourceOnPage` alone, with no view.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { WalletIndexer } from 'midnight-identity/profile/unlock';
import { anchorHeadsKept } from './builder-answers-kept.js';
import { companyViewFor, type HeldReader } from './company-view.js';
import { once } from './company-view-doors.js';
import type { HoldersOnPage, JudgeView } from './company-view-judges.js';
import { anchorsOnChainAt } from './records-anchored-here.js';
import { serviceSource, type RecordSource } from './records-source.js';
import { serviceCall } from './service-transport.js';
import { treeKeptHere } from './tree-kept-here.js';
import type { DirectoryBelieved } from './vault-page-doors.js';
import type { VaultBuilderClient, VaultOnChainOnTheWire } from './vault-worker-client.js';
import { vaultsReadInTheView } from './vaults-read-in-the-view.js';
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

/** The company's records as its service keeps them, asked through the page's one transport. */
export const sourceOnPage = (companyId: string): RecordSource => serviceSource(serviceCall, companyId);

/** The company's account names another place on the chain than the one its view was opened at. */
class NotWhereItWasOpened extends Error {
  constructor() {
    super('the company\'s account names another place on the chain than the one this view was opened at, so nothing is written through it.');
    this.name = 'NotWhereItWasOpened';
  }
}

/** Where a company is on the chain, as its account (or a row of the person's companies) names it; null while it has none. */
export const whereOnTheChainIn = (sealed: unknown): OnTheChain | null => {
  const s = (sealed ?? {}) as { readonly companyLabel?: unknown; readonly contractAddress?: unknown };
  const { companyLabel: company, contractAddress: account } = s;
  return typeof company !== 'string' || typeof account !== 'string' ? null : { company: company as CompanyLabel, account: account as AccountAddress };
};

/**
 * A new view of `companyId` for one opening of a screen, or for one read no screen makes. Whoever opens it holds it,
 * hands it to everything that reads through it, and ends it. `where`, when the opener already has it (a row of the
 * person's companies names it), is where the doors find the company on the chain, and the wallet door reads no account.
 */
export const openOnPage = (companyId: string, doors: PageDoors, where?: OnTheChain): JudgeView => {
  /* Else the wallet door finds the company on the chain from the view's one read of the account, before the view's first read. */
  const found = where === undefined ? once(async () => whereOnTheChainIn(await made.doors.account())) : async () => where;
  const there = async (): Promise<OnTheChain> => {
    const at = await found();
    if (at === null) throw new NotOnTheChainYet();
    return at;
  };
  /*
   * A place on the chain the opener named is believed for reading alone: every read of who holds the company after the
   * view's first, the check's before a write among them, first finds the company's own account naming that place.
   */
  let readOnce = false;
  const named = async (): Promise<OnTheChain> => {
    const at = await there();
    if (where !== undefined && readOnce) {
      const own = whereOnTheChainIn(await made.doors.account());
      if (own === null || own.company !== at.company || own.account !== at.account) throw new NotWhereItWasOpened();
    }
    readOnce = true;
    return at;
  };
  const made: JudgeView = companyViewFor(sourceOnPage(companyId), {
    holders: async (): Promise<HoldersOnPage> => {
      const read = await holdersFromTheWallet(doors.walletOrigin, await named());
      return { ...read.holders, indexer: read.indexer };
    },
    onChain: async () => {
      const at = await there();
      const { indexer } = await made.holders();
      return anchorsOnChainAt(await doors.builder(), at.account, indexer ?? null);
    },
    builder: {
      anchorHeads: async (ask) => anchorHeadsKept(await doors.builder())(ask),
      vaultsOnChain: async (ask) => (await doors.builder()).vaultsOnChain(ask),
    },
    /* The account's roles asked, as the same wallet reads them off the chain; the view keeps each answer for the set asked. */
    roles: async (asked) => ({ roles: (await holdersFromTheWallet(doors.walletOrigin, { ...(await there()), roles: asked })).roles }),
    kept: () => treeKeptHere(),
    directory: (view) => doors.directory(view),
  }, async (inner, asked) => doors.held(made, await there())(inner, asked));
  return made;
};

/**
 * The company's account as the service keeps it, the view's one read of it: the read its wallet door finds the company
 * on the chain with, and what the check compares the account's signers and wrapped keys against before a write. It
 * does not wait for the view's first read, so a company with no account on the chain yet, which no view reads, can
 * still be told apart here.
 */
export const accountOnPage = (view: JudgeView): Promise<unknown> => view.doors.account();

/** Where the view's company is on the chain, or null while it has no account there, from the view's one read of the account. */
export const onTheChain = async (view: JudgeView): Promise<OnTheChain | null> => whereOnTheChainIn(await view.doors.account());

/**
 * The indexer the person's wallet named when the view asked it who holds the company: the one place this page reads
 * the chain from for the company. Null when the wallet named none.
 */
export const indexerOnPage = async (view: JudgeView): Promise<WalletIndexer | null> => (await view.holders()).indexer ?? null;

/**
 * **A VAULT ON THE CHAIN, READ THROUGH THE VIEW.** Every vault the company's account adopted, as the view's holders name
 * them, is read with the first vault asked, in one `vaultsOnChain` ask at `indexer` through the view's builder, and each
 * answer is kept in the view for every tile of the opening (`vaultsReadInTheView`). `round` is 0, or a round the view
 * handed out for a press to read the vaults again (`vaultRoundOnPage`): each round reads the chain afresh, once for
 * every tile asking in it. Each round's reads are kept in the view, so they go when it ends.
 */
export const vaultOnPage = async (view: JudgeView, vault: string, indexer: WalletIndexer, round = 0): Promise<VaultOnChainOnTheWire> => {
  const inRound: () => Pick<JudgeView, 'layer'> = round === 0 ? () => view
    : () => ({ layer: (name, build) => view.layer(`${name}:again-${round}`, build) });
  const reads = await view.layer(`vaults-read:${round}`, async () => vaultsReadInTheView(inRound, view.doors.builder));
  reads.declare((await view.holders()).adoptedVaults);
  return reads.read(vault as Hex, indexer);
};

/**
 * A new round of reading the vaults again, for one press of the person's: handed out by the view, so no two presses in
 * one opening share a round, however often the screen that asks is drawn again.
 */
export const vaultRoundOnPage = (view: JudgeView): number => view.nextRound();
