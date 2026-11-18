/**
 * What a contract address looks like: 64 lower-case hex characters. Anything that keys work by a contract (a vault
 * circuit's callee, the private state staged for one company) reads its address through here, so an empty or
 * malformed address is refused before it can select anything.
 */

const CONTRACT_ADDRESS = /^[0-9a-f]{64}$/u;

/** The address in lower case, or a refusal naming `what` was given and why nothing can run against it. */
export const contractAddressOrRefuse = (address: string, what: string): string => {
  const lower = address.toLowerCase();
  if (!CONTRACT_ADDRESS.test(lower)) {
    throw new Error(`${what} "${address}" is not a contract address, so nothing can be run or kept against it.`);
  }
  return lower;
};
