import { ensureBuffer } from 'midnight-identity/browser';
import { startAccountBuilder } from './account-builder.js';

/**
 * THE WALLET'S ACCOUNT BUILDER, AS A MODULE WORKER. The contract runtime
 * reaches for Node's Buffer, which a worker does not have, so it is given one
 * before anything else loads; then the builder starts listening and says it is
 * ready.
 */
ensureBuffer();
startAccountBuilder(self as unknown as Parameters<typeof startAccountBuilder>[0]);
