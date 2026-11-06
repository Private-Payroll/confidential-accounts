/**
 * Where a device's prover finds the material of each circuit it proves: the vault's own, the company account's beside
 * them, and the network's own shielded circuits. A location goes to the source that serves the circuit it names, so the
 * vault's material is never asked for a circuit it does not hold.
 */
import { circuitOf, type ArtefactSource } from './key-material.js';
import { ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE } from '../../../src/midnight/vault-contract.js';
/**
 * **A PRIVATE DEPOSIT OR PAYMENT ALSO PROVES THE NETWORK'S OWN SHIELDED CIRCUITS**
 * (`spend`, `output`, `sign`), asked for as `midnight/zswap/<circuit>`. They are
 * served beside the vault's own, and every other name goes to the vault's.
 */
export const networkCircuitsBeside = (vault: ArtefactSource, network: ArtefactSource): ArtefactSource => {
  const which = (keyLocation: string) => (keyLocation.startsWith('midnight/zswap/') ? network : vault);
  return {
    lookupKey: (keyLocation) => which(keyLocation).lookupKey(keyLocation),
    getParams: (k) => vault.getParams(k),
    artefact: (kind, keyLocation) => which(keyLocation).artefact(kind, keyLocation),
  };
};

/**
 * **A PAYMENT OUT ALSO PROVES THE COMPANY ACCOUNT'S `recordPayment`**, which the
 * vault's `payout` calls inside the same transaction, **AND A RAISE OR AN
 * APPROVAL IS ONE OF THE ACCOUNT'S OWN CIRCUITS.** Their material is served
 * beside the vault's, and a location is sent there by the circuit it names: no
 * vault circuit shares a name with one of the account's served to a device.
 */
export const accountCircuitsBeside = (vault: ArtefactSource, account: ArtefactSource): ArtefactSource => {
  const which = (keyLocation: string) =>
    (ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE.includes(circuitOf(keyLocation)) ? account : vault);
  return {
    lookupKey: (keyLocation) => which(keyLocation).lookupKey(keyLocation),
    getParams: (k) => vault.getParams(k),
    artefact: (kind, keyLocation) => which(keyLocation).artefact(kind, keyLocation),
  };
};
