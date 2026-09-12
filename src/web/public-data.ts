/**
 * **THE CONTRACT'S PUBLIC STATE, READ FROM THE INDEXER THE WALLET NAMES.**
 *
 * -- THE ENDPOINTS COME FROM THE WALLET AND FROM NOWHERE ELSE --------------
 *
 * A wallet reports which indexer it is synchronised against. Reading the
 * contract from a DIFFERENT one is not a configuration mismatch that shows up
 * as an error: both answer, both answer plausibly, and the two views are of the
 * same chain at different heights or, worse, of different chains. What that
 * produces is a call assembled against one view of the account and balanced by
 * a wallet holding another, which fails after a proof and a fee with nothing
 * naming the cause.
 *
 * So this takes the wallet's own configuration object and there is no
 * parameter here for a URL somebody typed.
 *
 * -- IT MUST NOT BE REACHABLE FROM THE PAGE, AND THAT IS MEASURED ----------
 *
 * The indexer client reaches the wallet SDK's ledger module: it imports the
 * shared utilities, which deserialise contract state, and those reach the
 * ledger package, which is WebAssembly. Built on its own through this
 * application's own build, that is 24 modules of it and a ten megabyte binary.
 *
 * **THAT PACKAGE IS THE ONE THAT LEFT THIS APPLICATION'S PAGE BLANK IN EVERY
 * REAL BROWSER**, for four rounds: its glue throws while it is still being
 * evaluated, so nothing renders, and there is no error on the screen and none
 * in the console. A dynamic import does not help - it keeps the module off the
 * first chunk, and the page's build still carries it.
 *
 * **SO NOTHING THE PAGE LOADS MAY IMPORT THIS FILE**, statically or
 * dynamically. It belongs on the thread that already carries that package on
 * purpose, alongside the prover. The import below is dynamic for the reason the
 * provider bundle's is: so that the type checker and anything merely reading
 * this module do not instantiate a WebAssembly binary.
 *
 * `no-wasm-in-the-page.test.ts` is what notices if that is ever forgotten, and
 * `public-data.test.ts` is where the measurement above is kept so that it is a
 * fact somebody watched rather than a paragraph.
 */

/**
 * What a wallet reports about where to read.
 *
 * Declared structurally here rather than imported as a value for the reason the
 * connector module gives about its own copy: this file has to typecheck where
 * `window.midnight` does not exist. It is the same two fields that module's
 * `ConnectorConfiguration` declares.
 */
export interface IndexerEndpoints {
  indexerUri: string;
  indexerWsUri: string;
}

/** What `indexerPublicDataProvider` hands back. Narrow on purpose. */
export interface PublicDataProvider {
  queryContractState(...args: any[]): Promise<unknown>;
  watchForTxData?(...args: any[]): unknown;
  [more: string]: unknown;
}

const scheme = (uri: string): string | null => {
  try {
    return new URL(uri).protocol;
  } catch {
    return null;
  }
};

/**
 * Refuses endpoints that cannot be what they claim to be, naming what resolves
 * it in terms the reader can act on.
 *
 * **THE PACKAGE ITSELF REFUSES THE SAME TWO THINGS, AND THIS IS NOT
 * DUPLICATION OF A CHECK - IT IS DUPLICATION OF A SENTENCE.** Its own
 * validation reads the same two scheme sets and throws by the name of an
 * internal error class naming a protocol. What a person reading a screen needs
 * instead is which of the two addresses was wrong, where the value came from,
 * and that nothing was read. That is the only thing added here, and it is the
 * reason this runs first rather than the reason the check exists.
 *
 * **AND THE TWO FIELDS ARE FOUR CHARACTERS APART** in every configuration
 * anybody has ever written, which is why getting them the wrong way round is
 * the failure worth naming rather than an unlikely one.
 */
export const refuseEndpointsThatCannotWork = (endpoints: IndexerEndpoints): void => {
  const { indexerUri, indexerWsUri } = endpoints;

  if (!indexerUri || !indexerWsUri) {
    throw new Error(
      'the connected wallet did not say which indexer it is synchronised against, so there is ' +
        'nowhere to read this account from. Reconnect the wallet, or update it: the address is ' +
        'part of what it reports about itself.',
    );
  }

  const read = scheme(indexerUri);
  if (read !== 'http:' && read !== 'https:') {
    throw new Error(
      `the wallet reports its indexer at "${indexerUri}", which is not an address this can ` +
        'read from over HTTP. Nothing has been read.',
    );
  }

  const watch = scheme(indexerWsUri);
  if (watch !== 'ws:' && watch !== 'wss:') {
    throw new Error(
      `the wallet reports its indexer subscription at "${indexerWsUri}", which is not a ` +
        'websocket address, so nothing has been read. The two addresses a wallet reports differ ' +
        'by four characters and this is the one that watches for changes.',
    );
  }
};

/**
 * Builds the reader, over the endpoints the wallet reported.
 *
 * The import is dynamic and the module it loads is large. See the header: this
 * must not be called from anything the page's own build reaches.
 */
export const publicDataProviderFor = async (
  endpoints: IndexerEndpoints,
): Promise<PublicDataProvider> => {
  refuseEndpointsThatCannotWork(endpoints);

  const { indexerPublicDataProvider } = await import(
    '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
  );

  /*
   * **THE OPTIONS-OBJECT FORM, AND IT IS DELIBERATELY NOT THE POSITIONAL ONE
   * THE SERVER BUNDLE USES.** In what is installed here the object form is the
   * one the package documents and the positional one is marked deprecated and
   * kept for compatibility; the positional overload builds this same object and
   * hands it to the same validation one line later. The note about an options
   * object failing with "Invalid URL: [object Object]", which sits a few lines
   * away from the server bundle's indexer call, is about a DIFFERENT package's
   * constructor and an older version of it - checked, because reading it as
   * being about this one is what a hurried eye does.
   *
   * **NOT RUN AGAINST A LIVE INDEXER BY THE ROUND THAT WROTE IT.** What is
   * established is the shape the installed package accepts; whether a read
   * against a real chain comes back is a different question and a different
   * door.
   */
  return indexerPublicDataProvider({
    queryURL: endpoints.indexerUri,
    subscriptionURL: endpoints.indexerWsUri,
  }) as unknown as PublicDataProvider;
};
