/**
 * **THE DUST WALLET THAT SYNCS BY PROJECTIONS, AND THE LEDGER VERSION A NEW ONE STARTS ON.** The person's wallet runs
 * it in the browser and the service runs it as the fee payer in node, so it is written once, here, and loads in both:
 * nothing is imported but types until the wallet is built, and the indexer is read with `fetch`.
 */
import type { ForkingDustConfiguration, ForkingDustWalletClass } from '@midnightntwrk/wallet-sdk';
import type { DefaultV1Configuration, SyncService as V1Sync } from '@midnightntwrk/wallet-sdk/dust/v1';
import type { DefaultV2Configuration, SyncService as V2Sync } from '@midnightntwrk/wallet-sdk/dust/v2';

/**
 * **THE LEDGER VERSION OF THE NEWEST BLOCK THE INDEXER HOLDS.** The wallet library's own probe asks for the chain's
 * first block, which on a chain that crossed the ledger 9 fork names ledger 8, so a part started with it starts on
 * the old ledger and holds the whole facade there. Read by GraphQL over HTTP from the indexer the wallet names;
 * refuses when it names no block, or names one without a version.
 */
export async function tipProtocolVersion(
  indexerHttpUrl: string,
  post: (url: string, init: RequestInit) => Promise<{ json(): Promise<unknown> }> = (url, init) => fetch(url, init),
): Promise<bigint> {
  const answer = await post(indexerHttpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query { block { protocolVersion } }' }),
  });
  const version = ((await answer.json()) as { data?: { block?: { protocolVersion?: unknown } } } | null)?.data?.block?.protocolVersion;
  if (typeof version !== 'number' && typeof version !== 'string') throw new Error('the indexer named no newest block');
  return BigInt(version);
}

/**
 * What a projections DUST wallet is built from: what the forking wallet and each of its two variants read, with the
 * indexer the newest block's version is asked of. No rates are given, so every side is valued against ledger 9's own.
 */
export type ProjectionsDustConfiguration = ForkingDustConfiguration
  & Omit<DefaultV1Configuration, 'dustParameters'> & Omit<DefaultV2Configuration, 'dustParameters'>
  & Readonly<{ indexerClientConnection: Readonly<{ indexerHttpUrl: string }>; dustParameters?: never }>;

/** The wallet class `projectionsDustWallet` answers: ledger 8 synced by events, ledger 9 by projections. */
export type ProjectionsDustWalletClass = ForkingDustWalletClass<V1Sync.WalletSyncUpdate, V2Sync.DustProjectionsUpdate, ProjectionsDustConfiguration>;

/**
 * **THE SDK'S DUST WALLET WITH ITS LEDGER 9 VARIANT SYNCING BY PROJECTIONS**, composed as the library composes its
 * own (`DustWallet`) with only the sync changed: replaying every DUST event since the fork is millions of events,
 * which a browser does not finish and a fee payer takes hours over, and the projections read the wallet's own DUST
 * from the newest state. A fresh start asks the newest block's version (`tipProtocolVersion`), so on a chain past
 * the fork it begins on the ledger 9 variant with an empty state; DUST was wiped at the fork, so nothing is lost.
 * Below the fork it replays ledger 8 events as before. A probe that fails leaves the start where the library's own
 * would be.
 */
export async function projectionsDustWallet(configuration: ProjectionsDustConfiguration): Promise<ProjectionsDustWalletClass> {
  const sdk = await import('@midnightntwrk/wallet-sdk');
  const { V1Builder } = await import('@midnightntwrk/wallet-sdk/dust/v1');
  const { V2Builder, SyncService } = await import('@midnightntwrk/wallet-sdk/dust/v2');
  const probed = {
    ...configuration,
    chainVersionProbe: async () =>
      sdk.ProtocolVersion.ProtocolVersion(await tipProtocolVersion(configuration.indexerClientConnection.indexerHttpUrl)),
  };
  const { v1, v2, migration } = sdk.dustVariantConfigurations(probed);
  return sdk.CustomForkingDustWallet(
    probed,
    { builder: new V1Builder().withDefaults(), configuration: v1 },
    {
      builder: new V2Builder().withDefaults()
        .withSync(SyncService.makeEventLessSyncService, SyncService.makeEventLessSyncCapability)
        .withStartAuxDefaults()
        .withMigration(migration),
      configuration: v2,
    },
  );
}
