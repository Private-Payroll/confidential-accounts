/**
 * **WHAT THE INDEXER CLIENT DRAGS IN WITH IT, MEASURED, AND THE REFUSALS THAT
 * KEEP A WRONG ENDPOINT FROM BEING SILENT.**
 *
 * -- THE MEASUREMENT IS THE POINT OF THIS FILE -----------------------------
 *
 * The specification this was built from calls the public data provider
 * "ordinary wiring". It is, in every respect except one: the package reaches
 * the wallet SDK's ledger module, which is the WebAssembly that left this
 * application's page blank in every real browser for four rounds. A dynamic
 * import does not change that - the page's BUILD still carries it - so the
 * module that wraps this package can never be reachable from the page's own
 * graph, and where a governed call is built is therefore not a free choice.
 *
 * That is a claim about a module graph, so it is measured by asking the
 * bundler, in the same way the page's own guard does, rather than read off the
 * package's manifest. A static read of a package's dependencies says what MIGHT
 * be reached; what is asserted here is what a production build actually loads.
 *
 * **AND IT IS ASSERTED IN THE DIRECTION THAT MAKES IT NEWS EITHER WAY.** If the
 * package ever stops reaching the ledger, this case goes red, and that is worth
 * knowing: it would mean the reader could live in the page after all.
 */
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { publicDataProviderFor, refuseEndpointsThatCannotWork } from './public-data.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The same two families the page's own guard names, and for the same reason:
 * the extension alone misses a wasm-bindgen package's glue, and the packages
 * alone miss a binary from somewhere else.
 */
const WEBASSEMBLY = /@midnightntwrk[/\\](?:ledger-v9|onchain-runtime-v4)|\.wasm(\?|$)/;

/**
 * Builds ONE module through a production build and reports which WebAssembly
 * packages its graph reached.
 *
 * A library build of the single file rather than the page, because the question
 * is what THIS module brings with it. `NODE_ENV` is set and put back for the
 * reason the page's guard documents: the build tool reads it first and the
 * runner has set it to `test`, so a production build asked for inside a test is
 * otherwise a development one.
 */
const packagesReachedBy = async (file: string): Promise<string[]> => {
  const out = mkdtempSync(join(tmpdir(), 'mn-reach-out-'));
  const cacheDir = mkdtempSync(join(tmpdir(), 'mn-reach-cache-'));
  const modules = new Set<string>();
  const wasEnv = process.env.NODE_ENV;

  try {
    process.env.NODE_ENV = 'production';
    await build({
      configFile: false,
      root: REPO,
      mode: 'production',
      cacheDir,
      logLevel: 'silent',
      build: {
        outDir: out,
        emptyOutDir: true,
        lib: { entry: join(REPO, file), formats: ['es'], fileName: 'probe' },
      },
      plugins: [{ name: 'record-the-graph', moduleParsed(info: { id: string }) { modules.add(info.id); } }],
    });
  } finally {
    process.env.NODE_ENV = wasEnv;
  }

  const reached = [...modules]
    .filter((id) => WEBASSEMBLY.test(id))
    .map((id) => id.replace(/^.*node_modules[/\\](@midnightntwrk[/\\][^/\\]+)[/\\].*$/, '$1'));
  return [...new Set(reached)].sort();
};

describe('what the indexer client brings with it', () => {
  it('REACHES THE WALLET SDK\'S LEDGER, which is why it cannot live in the page',
    { timeout: 180_000 }, async () => {
      const reached = await packagesReachedBy(join('src', 'web', 'public-data.ts'));

      expect(reached,
        'the reader for the contract\'s public state no longer reaches the wallet SDK\'s ledger. '
        + 'If that is true, this reader could live in the page after all and the reason it is '
        + 'kept off the page has gone - read what changed before changing this list')
        .toEqual(['@midnightntwrk/ledger-v9', '@midnightntwrk/onchain-runtime-v4']);
    });

  /**
   * **THE CONTROL FOR THE CASE ABOVE, AND IT IS NOT DECORATION.** Without it,
   * "this module reaches WebAssembly" would also be true of a measurement that
   * matched everything, a build that produced nothing, and a pattern that
   * matched the whole of `node_modules`. The adapter beside it is a real module
   * in this repository, built through the same function, and it reaches none.
   */
  it('and the provider a call is assembled with reaches none of it, through the same measurement',
    { timeout: 180_000 }, async () => {
      const reached = await packagesReachedBy(join('src', 'web', 'zk-config.ts'));

      expect(reached,
        'the adapter over the artefact cache has started reaching WebAssembly. It has no run-time '
        + 'import of the package whose types it uses, and that is what keeps it loadable anywhere')
        .toEqual([]);
    });
});

describe('the endpoints a wallet reports', () => {
  const good = { indexerUri: 'https://indexer.example/api/v1/graphql', indexerWsUri: 'wss://indexer.example/api/v1/graphql/ws' };

  it('accepts what a wallet actually reports', () => {
    expect(() => refuseEndpointsThatCannotWork(good)).not.toThrow();
  });

  it('accepts the plain-http pair a local node reports', () => {
    expect(() => refuseEndpointsThatCannotWork({
      indexerUri: 'http://localhost:8088/api/v1/graphql',
      indexerWsUri: 'ws://localhost:8088/api/v1/graphql/ws',
    })).not.toThrow();
  });

  it.each([
    ['', good.indexerWsUri],
    [good.indexerUri, ''],
  ])('refuses when the wallet named nothing (%s, %s)', (indexerUri, indexerWsUri) => {
    expect(() => refuseEndpointsThatCannotWork({ indexerUri, indexerWsUri }))
      .toThrow(/did not say which indexer/);
  });

  it('refuses a read address that is not an HTTP one', () => {
    expect(() => refuseEndpointsThatCannotWork({ ...good, indexerUri: 'wss://indexer.example/graphql' }))
      .toThrow(/not an address this can read from over HTTP/);
  });

  it('refuses a read address that is not an address at all', () => {
    expect(() => refuseEndpointsThatCannotWork({ ...good, indexerUri: 'indexer.example' }))
      .toThrow(/not an address this can read from over HTTP/);
  });

  /**
   * **THE EASIEST ONE TO GET WRONG.** The two fields differ by four characters
   * in every configuration anybody has written. The package refuses this one
   * too, by the name of an internal protocol error; what is refused here is
   * refused in words that say which of the two addresses was wrong and that
   * nothing was read.
   */
  it('refuses an http address in the subscription slot, in words a reader can act on', () => {
    expect(() => refuseEndpointsThatCannotWork({ ...good, indexerWsUri: good.indexerUri }))
      .toThrow(/not a websocket address/);
  });

  it('will not build a reader from endpoints it has refused', async () => {
    await expect(publicDataProviderFor({ indexerUri: '', indexerWsUri: '' }))
      .rejects.toThrow(/did not say which indexer/);
  });
});
