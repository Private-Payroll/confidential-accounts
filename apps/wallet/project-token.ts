/**
 * **THE PROJECT TOKEN OF THE NETWORK A WALLET IS BUILT FOR, AND NO OTHER.**
 *
 * A network whose record asks for a project token answers its node and indexer
 * only with one, and the wallet calls both from the browser. So the token is
 * put into the build as the one setting the network's record names, and the
 * record's reader joins it to each endpoint in the page. It is read from the
 * build's environment and written into no file. Only the built network's
 * token is read, so a token for any other network never reaches the wallet.
 */
import { networkRecord } from '../../src/core/networks.js';

/**
 * The build-time settings that carry `network`'s project token into the
 * wallet: none for a network that asks for no token. Refuses a build for a
 * network that asks for one when the setting is empty, naming it, rather than
 * shipping a wallet every one of whose calls the network refuses.
 */
export function projectTokenSettings(
  network: string,
  setting: (name: string) => string | undefined
): Record<string, string> {
  const token = networkRecord(network).endpoints?.projectToken ?? null;
  if (token === null) return {};
  const value = setting(token.setting)?.trim();
  if (!value) {
    throw new Error(
      `this wallet is built for "${network}", which answers only a caller that names a project, ` +
        `and ${token.setting} is not set. Set it in the environment of the build or in the repository's .env.`
    );
  }
  return { [`import.meta.env.${token.setting}`]: JSON.stringify(value) };
}
