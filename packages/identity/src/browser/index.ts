/**
 * The browser half — `midnight-identity/browser`.
 *
 * Anything with a platform behind it lives here: passkeys now, local storage
 * and cloud homes for recovery pieces later. A server-side host imports
 * `midnight-identity` and never pulls this into its bundle.
 */
/*
 * FIRST, AND FOR A REASON. `address-format` is written against Node's `Buffer`,
 * which a browser does not have — so importing this entry point is what makes
 * `addressFor` work in a browser at all.
 */
export { ensureBuffer } from './buffer.js';

export { createPasskey, passkeysAvailable, usePasskey } from './passkey.js';
export type { CreateOptions, GetOptions } from './passkey.js';
