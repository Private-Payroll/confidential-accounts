/**
 * **A DEPOSIT THIS DEVICE NEVER HANDED OVER TO BE SENT IS ENDED ON ITS JOURNAL LINE.** A private deposit files its
 * coin in the vault's deposit journal before it is built; from then until the transaction is handed to something that
 * could send it, every failure lets go of this device's claim on it and marks its line ended, so no check of the vault
 * says a deposit that cannot land is on its way. A line that cannot be marked is said in the refusal itself, never
 * passed over. Facts come from this device's own records and the vault's journal.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { endDepositNeverHandedOver } from '../../../src/midnight/vault-journal.js';
import type { KeptOnThisDevice } from './in-flight-on-this-device.js';
import type { PoolDoors } from './vault-doors.js';

/** What ending a line needs: the vault's records, this device's seat, the signers, and its deposits kept on their way. */
type DepositDoors = Pick<PoolDoors, 'records' | 'me' | 'signers'> & { readonly inFlight: Pick<KeptOnThisDevice<unknown>, 'forget'> };

/**
 * **THE DEPOSIT WAS NOT SENT, AND ITS JOURNAL LINE COULD NOT BE MARKED AS NEVER SENT.** Says what stopped the deposit
 * (its `cause`, in its own words) and that, until the line's window passes, a check of the vault may still say the
 * deposit is on its way although it can never arrive.
 */
export class DepositLineNotEnded extends Error {
  constructor(readonly stopped: Error, why: string) {
    super(`${stopped.message.replace(/\s*$/u, '')} This deposit's line in the vault's deposit journal could not be marked as `
      + `never sent (${why}), so until its window passes a check of this vault may say it is still on its way. It was not `
      + 'sent and cannot arrive.', { cause: stopped });
    this.name = 'DepositLineNotEnded';
  }
}

/** Forgotten as in flight. A failure to forget is not a failure of the deposit: the next look finds it settled again. */
export const letGo = async (doors: DepositDoors, vault: Hex, claim: string): Promise<void> => {
  await doors.inFlight.forget(vault, claim).catch(() => { /* the next look settles it again, and finds nothing to do */ });
};

/**
 * **A DEPOSIT THIS DEVICE NEVER HANDED OVER TO BE SENT**: its claim here, if it took one, is let go, and its line in
 * the vault's deposit journal is marked ended, so no check says a deposit that cannot land is on its way. Called only
 * where this device never handed the transaction to anything that could send it. Returns the error to throw: `stopped`
 * itself, or, when the line could not be marked, `DepositLineNotEnded` saying so.
 */
export const neverHandedOver = async (doors: DepositDoors, vault: Hex, nonce: string, stopped: Error, claim?: string): Promise<Error> => {
  if (claim !== undefined) await letGo(doors, vault, claim);
  try {
    await endDepositNeverHandedOver(doors.records('deposit-journal'), vault,
      { id: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers, nonce);
    return stopped;
  } catch (e) {
    return new DepositLineNotEnded(stopped, e instanceof Error ? e.message : String(e));
  }
};

/**
 * **ONE STEP BETWEEN FILING A DEPOSIT'S LINE AND HANDING IT OVER**: its answer, or, when it throws, the line ended (and
 * the claim let go, when one was taken) before the failure is thrown on, so a build or a read that fails here never
 * leaves a deposit said to be on its way.
 */
export const endedIfItThrows = async <T>(
  doors: DepositDoors, vault: Hex, nonce: string, step: () => Promise<T>, claim?: string,
): Promise<T> => {
  try {
    return await step();
  } catch (e) {
    throw await neverHandedOver(doors, vault, nonce, e instanceof Error ? e : new Error(String(e)), claim);
  }
};
