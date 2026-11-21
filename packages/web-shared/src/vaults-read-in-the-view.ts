/**
 * **THE VAULTS A STEP OR AN OPENING OF A PAGE STANDS ON, READ ONCE FOR IT.** Every vault whose standing is asked in one
 * turn, with every vault named before it read (`declare`), goes in one `vaultsOnChain` ask (one for each 256), read
 * with the company's account when one is named. Each answer is kept in the view of the company and serves every later
 * read of the same vault until the view writes anything or is opened again (`company-view.ts`, `chain-read:`). When
 * the one ask fails, or leaves a vault out, each vault is read on its own (`eachVaultRead`) and settles from its own
 * ask, so a vault that cannot be read, or does not answer, fails only its own readers. A failure is kept like any other
 * answer, for the life of the view; after the view writes, a vault that failed is asked alone, never in the join.
 *
 * Only a vault's standing is read through this (`vaultStandingHere`): a read that must see the chain as it is now,
 * such as a second read that confirms a note is gone or a wait for a send to land, reads it again (`readHere`).
 */
import type { AccountAddress } from 'midnight-identity/profile/company-label';
import { JoinedAsks } from './company-view-batch.js';
import type { CompanyView } from './company-view.js';
import type { Hex } from '../../../src/core/crypto.js';
import type { VaultBuilderClient, VaultOnChainOnTheWire } from './vault-worker-client.js';

/** The indexer the person's own wallet names, which every vault of the step is read at. */
type Indexer = { readonly indexerUri: string; readonly indexerWsUri: string };

/** What `vaultsOnChain` is asked: the vaults, the indexer, and the account whose circuits are read with them, if any. */
type VaultsAsk = Parameters<VaultBuilderClient['vaultsOnChain']>[0];
/** One vault's read, or what its own read failed with. */
type VaultRead = { readonly read: VaultOnChainOnTheWire } | { readonly failed: unknown };

/** A vault's own answer, settled when the ask that answers it lands, apart from every other vault's. */
type Settles = { readonly settled: Promise<VaultRead> };

const short = (asked: number, reads: unknown) => new Error(`an answer held ${String(Array.isArray(reads) ? reads.length : reads)} entries for the ${asked} asked`);

/** One vault asked alone: its read, or the failure of its own ask. */
const oneVaultRead = async (builder: Pick<VaultBuilderClient, 'vaultsOnChain'>, ask: VaultsAsk): Promise<VaultRead> => {
  try {
    const reads = await builder.vaultsOnChain(ask);
    return Array.isArray(reads) && reads.length === 1 ? { read: reads[0]! } : { failed: short(1, reads) };
  } catch (failed) {
    return { failed };
  }
};

/**
 * **EVERY VAULT ASKED, READ IN ONE ASK, AND ONE THAT CANNOT BE READ FAILS ONLY ITSELF.** The vaults go in one
 * `vaultsOnChain` ask; when it fails, or answers otherwise than with one read for each vault, each vault is asked on its
 * own and settles when its own ask lands, so a vault that does not answer holds up no other vault's read. A lone
 * vault's failed ask is its own failure, asked once.
 */
async function eachVaultRead(builder: Pick<VaultBuilderClient, 'vaultsOnChain'>, ask: VaultsAsk): Promise<Settles[]> {
  const at = (r: VaultRead): Settles => ({ settled: Promise.resolve(r) });
  try {
    const reads = await builder.vaultsOnChain(ask);
    if (Array.isArray(reads) && reads.length === ask.vaults.length) return reads.map((read) => at({ read }));
    if (ask.vaults.length <= 1) return ask.vaults.map(() => at({ failed: short(ask.vaults.length, reads) }));
  } catch (failed) {
    if (ask.vaults.length <= 1) return ask.vaults.map(() => at({ failed }));
  }
  return ask.vaults.map((vault) => ({ settled: oneVaultRead(builder, { ...ask, vaults: [vault] }) }));
}

/** The vault's read, or the failure of its own read, thrown. */
const theVaultRead = (r: VaultRead): VaultOnChainOnTheWire => {
  if ('failed' in r) throw r.failed;
  return r.read;
};

/** A step's reads of its vaults' standing, kept in its view. */
export interface VaultsReadOnce {
  /** Names the vaults the step will read, so the first read reads them all together. */
  declare(vaults: readonly string[]): void;
  /** The vault as the chain holds it, read with `account`'s circuits when named, from the view's one read of its vaults. */
  read(vault: Hex, indexer: Indexer, account?: AccountAddress): Promise<VaultOnChainOnTheWire>;
}

/** What one view keeps of its vaults: how they are asked, the joined ask, which vaults went in it, and each asked alone. */
interface KeptReads {
  readonly ask: (vaults: readonly string[]) => VaultsAsk;
  readonly joined: JoinedAsks<string, Settles>;
  readonly inTheJoin: Set<string>;
  readonly alone: Map<string, Promise<VaultRead>>;
}

/**
 * The vaults read through `view`, the view as it is when each read is asked. A vault whose read failed is kept failed
 * for the view; once the view writes, that vault is asked alone for as long as this reader lasts (one step, or one
 * round of a page's opening), so a vault that does not answer never joins the healthy vaults' ask again.
 */
export function vaultsReadInTheView(
  view: () => Pick<CompanyView<unknown>, 'layer'>, builder: Pick<VaultBuilderClient, 'vaultsOnChain'>,
): VaultsReadOnce {
  const declared = new Set<string>();
  const failed = new Set<string>();
  const keptIn = (indexer: Indexer, account: string | undefined): Promise<KeptReads> => {
    const ask = (vaults: readonly string[]): VaultsAsk => (account === undefined ? { vaults, indexer } : { vaults, account, indexer });
    return view().layer(`chain-read:vaults:${account ?? ''}:${indexer.indexerUri}`, async (): Promise<KeptReads> => ({
      ask,
      joined: new JoinedAsks<string, Settles>((v) => v, (vaults) => eachVaultRead(builder, ask(vaults))),
      inTheJoin: new Set<string>(),
      alone: new Map<string, Promise<VaultRead>>(),
    }));
  };
  const noted = (v: string) => (r: VaultRead): VaultRead => {
    if ('failed' in r) failed.add(v); else failed.delete(v);
    return r;
  };
  const answerOf = (kept: KeptReads, v: string): Promise<VaultRead> => {
    if (kept.inTheJoin.has(v) || !failed.has(v)) {
      kept.inTheJoin.add(v);
      return kept.joined.get(v).then((s) => s.settled).then(noted(v));
    }
    let own = kept.alone.get(v);
    if (own === undefined) { own = oneVaultRead(builder, kept.ask([v])).then(noted(v)); kept.alone.set(v, own); }
    return own;
  };
  return {
    declare: (vaults) => { for (const v of vaults) declared.add(v.toLowerCase()); },
    read: async (vault, indexer, account) => {
      const kept = await keptIn(indexer, account === undefined ? undefined : String(account).toLowerCase());
      const mine = String(vault).toLowerCase();
      const own = answerOf(kept, mine);
      /* The declared vaults join the same ask; each is awaited only by its own reader, and no answer ever rejects. */
      for (const v of declared) if (v !== mine && !failed.has(v)) void answerOf(kept, v);
      return theVaultRead(await own);
    },
  };
}

/** A read with the account's circuits, as a read that did not name the account answers it. */
export const withoutTheAccount = (read: VaultOnChainOnTheWire): VaultOnChainOnTheWire => {
  if (!read.onChain || !('accountCircuits' in read)) return read;
  const { accountCircuits: _left, ...rest } = read;
  return rest;
};
