/**
 * The standalone wallet's fixed choices, in one place.
 *
 * THE PORT IS 5180 AND MUST STAY 5180 (`vite.config.ts`). A passkey belongs to
 * an origin and an origin includes the port, so an account created on 5180 is
 * unreachable from 5181. Nothing here may be derived from "whatever is free".
 */

/**
 * THE NETWORK IS STAGENET — §7.16, decided 19 Aug. **The constant
 * itself now lives in `../wallet/network.ts` and is re-exported here**, so
 * every screen goes on reading it from `config` and nothing else moved.
 *
 * It moved because it is not this application's setting. **Payroll writes the
 * same person's address from the same key and must write it on the same
 * network**, or it re-derives a different string and refuses a sign-in that is
 * perfectly good — found the first time the two were walked together.
 * A value two products must agree about cannot live in a file only one of them
 * can import: this one reads `window.location`, so a server cannot load it.
 */
export { NETWORK } from 'midnight-identity/network';

import type { InboxHost } from 'midnight-identity/profile/inbox';

/**
 * The indexer this wallet reads balances from — asked ONLY when the person
 * presses "Check the balance", and named in the footer, because asking it
 * tells its operator this wallet's address (§7.16). The endpoints
 * live beside `NETWORK` on purpose: an indexer answers for exactly one
 * network, and separating them is how a stagenet wallet ends up reading a
 * testnet chain and calling the result a balance.
 */
export const INDEXER_HTTP_URL = 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
/* FACT, not convention: this exact websocket URL carried the run that settled
 * a full approval round on stagenet, and a live probe synced
 * through it — verified against things
 * that worked, not read off a README. */
export const INDEXER_WS_URL = 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws';
/** The indexer, as a person reads it — for the footer and the balance card. */
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

/** The domain passkeys are bound to. No scheme, no port — that is the spec. */
export const RP_ID = window.location.hostname;

export const ORIGIN = window.location.origin;

/** What the person sees in the browser's passkey prompt and account picker. */
export const RP_NAME = 'Midnight Identity';
