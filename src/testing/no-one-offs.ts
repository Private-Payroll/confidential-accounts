import type { OneOffsHere } from '../../packages/web-shared/src/one-off-here.js';
import { vaultDetails } from './vault-details.js';

/**
 * The one-off payments door of a test company that has made none. Its directory names no one-off, so nothing is read
 * through this door; a read that reaches it is refused, so a test that should have filed one cannot pass on nothing.
 */
export const noOneOffsHere = (): OneOffsHere => ({
  at: async () => { throw new Error('this test\'s company has made no one-off payment, so none is read'); },
  keys: '00'.repeat(32),
  detailsOf: vaultDetails,
  open: () => { throw new Error('this test\'s company has made no one-off payment, so none is opened'); },
  treeOf: () => { throw new Error('this test\'s company has made no one-off payment, so none is rebuilt'); },
});
