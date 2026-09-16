/**
 * THE RULES THE FEE PAYER'S OWN PROCESS STARTS BY, IN A FILE THAT BRINGS
 * NOTHING UP.
 *
 * Starting the fee payer means bringing a funded wallet up, which takes a seed,
 * a proof server, a sync and minutes. Every refusal it can make before that is
 * here, so it can be read and pinned without a wallet.
 */
import { feeCeilingFrom, type FeeCeiling } from '../src/midnight/fee-ceiling.js';
import { SHORTEST_SECRET } from '../src/fee-payer/service.js';
import { FEE_PAYER_SECRET_SETTING } from '../src/fee-payer/client.js';

/** The loopback port the fee payer answers on. The web process names the same one. */
export const FEE_PAYER_PORT_SETTING = 'MIDNIGHT_FEE_PAYER_PORT';

/**
 * The seed of the wallet that pays.
 *
 * **SWAPPING THE WALLET THAT PAYS IS CHANGING THIS AND RESTARTING.** It has no
 * default. The obvious default is the seed the other doors on this machine pay
 * from, and two processes paying from one wallet book the same coins: the
 * fee payer's wallet is this process's alone.
 */
export const FEE_PAYER_SEED_SETTING = 'MIDNIGHT_FEE_PAYER_SEED_FILE';

/** The fee payer is only ever served on this machine's own loopback. */
export const FEE_PAYER_HOST = '127.0.0.1';

export interface FeePayerSetup {
  readonly port: number;
  readonly seedFile: string;
  readonly secret: string;
  readonly ceiling: FeeCeiling;
}

/**
 * Everything the fee payer needs from its settings, or every reason it cannot
 * start - all of them, not the first, so one run names everything missing.
 */
export function feePayerSetupFrom(
  env: Readonly<Record<string, string | undefined>>,
  root: string,
  exists: (path: string) => boolean,
): FeePayerSetup | { refusals: string[] } {
  const refusals: string[] = [];

  const rawPort = env[FEE_PAYER_PORT_SETTING]?.trim() ?? '';
  const port = /^[0-9]+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    refusals.push(
      `${FEE_PAYER_PORT_SETTING} is not a port, so there is nowhere to answer. Set it to the port `
      + 'the web process\'s fee payer address names');
  }

  const secret = env[FEE_PAYER_SECRET_SETTING] ?? '';
  if (secret.length < SHORTEST_SECRET) {
    refusals.push(
      `${FEE_PAYER_SECRET_SETTING} is ${secret.length === 0 ? 'not set' : 'too short'}. It must be `
      + `at least ${SHORTEST_SECRET} characters, and the web process must be given the same one`);
  }

  const seedFile = env[FEE_PAYER_SEED_SETTING]?.trim() ?? '';
  if (seedFile === '') {
    refusals.push(
      `${FEE_PAYER_SEED_SETTING} is not set. It names the seed of the wallet that pays, and it `
      + 'has no default: set it to a wallet no other process on this machine pays from');
  } else if (!exists(seedFile)) {
    refusals.push(
      `there is no seed for the wallet that pays at the file ${FEE_PAYER_SEED_SETTING} names. `
      + 'Put one there, or name the one to pay from');
  }

  let ceiling: FeeCeiling | null = null;
  try {
    ceiling = feeCeilingFrom(env);
  } catch (e) {
    refusals.push(String((e as Error).message).replace(/\.$/, ''));
  }

  if (refusals.length > 0 || ceiling === null) return { refusals };
  return { port, seedFile, secret, ceiling };
}
