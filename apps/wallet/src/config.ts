/**
 * The standalone wallet's fixed choices, in one place.
 *
 * THE PORT IS 5180 AND MUST STAY 5180 (`vite.config.ts`). A passkey belongs to
 * a relying party - a NAME, with no port - but what this wallet keeps in the
 * browser belongs to an origin, and an origin includes the port: a wallet
 * created on 5180 is not in the storage 5181 reads. Nothing here may be derived
 * from "whatever is free".
 */
import { buildSetting, embedderFrom, relyingPartyIdFor } from 'midnight-identity/profile/origin';

/**
 * **THE NETWORK THIS WALLET IS BUILT FOR.** The constant lives in
 * `midnight-identity/network` and is re-exported here, so every screen reads it
 * from `config` and nothing else.
 *
 * It is not this application's setting. **Payroll writes the same person's
 * address from the same key and must write it on the same network**, or it
 * re-derives a different string and refuses a sign-in that is perfectly good.
 * A value two products must agree about cannot live in a file only one of them
 * can import: this one reads `window.location`, so a server cannot load it.
 */
import { NETWORK } from 'midnight-identity/network';
import { endpointsOf } from '../../../src/core/networks.js';

export { NETWORK };

import type { InboxHost } from 'midnight-identity/profile/inbox';

/**
 * **WHERE THIS WALLET REACHES ITS NETWORK, READ FROM THE NETWORK'S ONE
 * RECORD.** An indexer answers for exactly one network, so the endpoints come
 * from the same record as the network's name and are never written here; a
 * wallet reading one network's indexer while it names another would call the
 * result a balance. Where the network asks for a project token, the record's
 * reader joins it to each endpoint from the setting this wallet was built
 * with, so the token is in the built wallet and in no file.
 *
 * The indexer is asked ONLY when the person presses "Check the balance", and
 * it is named in the footer, because asking it tells its operator this
 * wallet's address.
 */
export const NETWORK_ENDPOINTS = endpointsOf(NETWORK);

export const INDEXER_HTTP_URL = NETWORK_ENDPOINTS.indexer;
export const INDEXER_WS_URL = NETWORK_ENDPOINTS.indexerWs;
/** The indexer, as a person reads it: the host alone, for the footer and the balance card. */
export const INDEXER_HOST = new URL(INDEXER_HTTP_URL).host;

/**
 * THE INBOX HOST, AND IT IS DELIBERATELY `null`.
 *
 * **THERE IS NO INBOX HOST. NOT AN UNREACHABLE ONE — NONE.** Nothing in the
 * other repository answers `midnight-identity/inbox-ask/v1`, and
 * `profile/inbox.ts` states the contract one would have to satisfy. A URL
 * written here for a host that does not exist would be a value naming nothing,
 * committed to a repository that is going public, that later work has to
 * find and change — and until it did, every screen reading it would be
 * describing a relationship the product does not have.
 *
 * **SO THE TRANSPORT IS A DEPENDENCY AND THIS IS THE PLACE THAT SUPPLIES NONE.**
 * `app/inbox-live.ts` takes it as a parameter defaulting to this, so a test
 * drives a real transport with no network and the shipped build asks nobody
 * anything. The card renders `no-host` and says so in those words — which is a
 * different sentence from *the host did not answer*, deliberately.
 *
 * The day a host exists this becomes an object with a `describes` a person can
 * read and an `items` that fetches. Nothing else on this path changes.
 */
export const INBOX_HOST: InboxHost | null = null;

/**
 * **THE ONE PAGE ALLOWED TO HOLD THIS WALLET INSIDE ITSELF, OR NULL.**
 *
 * Set when the wallet is built for a product that frames it; absent for a
 * wallet that stands alone. It decides three things together, which is why it
 * is one value rather than three: who may frame this wallet, who a framed
 * wallet answers, and which name its passkeys belong to. A value this wallet
 * could not trust as an asker stops the page here, before any screen renders.
 */
export const EMBEDDER: string | null = embedderFrom(buildSetting('VITE_APP_ORIGIN'));

/**
 * **THE NAME PASSKEYS ARE MADE FOR. No scheme, no port - that is the spec.**
 *
 * **NOT THIS PAGE'S HOST WHEN THE WALLET HAS AN EMBEDDER.** A passkey made for
 * `identity.<site>` is refused on `app.<site>` with `SecurityError`, so one
 * passkey could never cover the two surfaces the product is laid out as. It is
 * made for the site both share instead, which the browser offers on every host
 * beneath it. A standalone wallet keeps its own host, as it always has.
 */
export const RP_ID = relyingPartyIdFor(window.location.hostname, EMBEDDER);

export const ORIGIN = window.location.origin;

/** What the person sees in the browser's passkey prompt and account picker. */
export const RP_NAME = 'Midnight Identity';
