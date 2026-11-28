import { networkRecord } from '../../../../src/core/networks.js';
import { NETWORK } from '../config.js';

/**
 * What a screen calls the network this wallet is built for, read from that
 * network's own record. A screen never writes a network's name itself.
 */
export const NETWORK_LABEL: string = networkRecord(NETWORK).label;

/**
 * The network's name for the free test money it gives away, or `null` on a
 * network that gives none away. A sentence about a faucet is shown only where
 * this says there is one.
 */
export const FAUCET_NAME: string | null =
  networkRecord(NETWORK).endpoints?.faucet == null ? null : `${NETWORK_LABEL} faucet`;
