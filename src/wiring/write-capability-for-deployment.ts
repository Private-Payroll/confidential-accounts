/**
 * THE FIVE, SUPPLIED. ONE FUNCTION, AND EVERY PROCESS THAT CAN WRITE CALLS IT.
 *
 * Next door says WHAT a deployment must hold before it can write to the chain
 * and what the refusal is for each piece it has not got. This says where each
 * piece comes from. They are separate files because the first is read by
 * anything that refuses a write and the second is reached only by a process
 * that is about to make one.
 *
 * -- WHERE EACH OF THE FIVE COMES FROM, AND THE SHAPE OF THE ANSWER ---------
 *
 * **THREE ARE THIS DEPLOYMENT'S OWN FACTS AND IT RESOLVES THEM ITSELF.** The
 * maintenance authority is read off the record a person wrote before anything
 * was deployed; the compiled contract is assembled from the artefacts on disk;
 * the private state key comes from this deployment's own configuration. None
 * of the three can be sampled, defaulted or invented here, and each refuses by
 * name rather than producing something plausible.
 *
 * **TWO ARE HANDED IN, BECAUSE THEY ARE A FUNDED WALLET AND A PROCESS DOES NOT
 * ACQUIRE ONE BY STARTING UP.** The company's side balances and signs; the fee
 * payer's side balances the fee, submits, and is the only thing in this system
 * with spend authority. A server that quietly acquired either would be a server
 * that can spend, so they arrive as an argument or the deployment does not
 * write. **`null` is the ordinary answer and not a failure**: a deployment built
 * to watch a chain reads accounts, balances and rounds perfectly well and has no
 * business holding a wallet.
 *
 * -- WHY IT ANSWERS WITH THE WHOLE OBJECT OR WITH NOTHING -------------------
 *
 * Because the honest states are two and not thirty-two. There is no path here
 * that answers with four of the five: a deployment holding four cannot write,
 * it can only fail later and further in, at the moment a transaction is already
 * being paid for. So every piece is resolved before the object exists, and a
 * piece that cannot be resolved is a refusal rather than a hole.
 */
import { loadMaintenanceAuthority } from '../midnight/authority-file.js';
import { compiledAccountContract } from '../midnight/compiled-account.js';
import type { CustomerWallet } from '../midnight/providers.js';
import type { FeeSponsor } from '../midnight/ledger.js';
import type { WriteCapability } from './write-capability.js';

/**
 * The two parties a funded wallet becomes.
 *
 * **THEY ARE TWO MEMBERS AND NOT ONE OBJECT WITH TWO ROLES**, for the reason
 * the capability next door keeps them apart: they are two parties, one of them
 * spends, and the day they are two machines nothing above this line changes.
 */
export interface FundedParties {
  readonly customer: CustomerWallet;
  readonly sponsor: FeeSponsor;
}

/**
 * The private state key, as a function.
 *
 * **A FUNCTION RATHER THAN A STRING SO THE MATERIAL IS FETCHED WHEN IT IS
 * NEEDED** and is not sitting in a resolved configuration object for the life
 * of the process. Today it comes from the environment, which is where this
 * deployment keeps it; the day it comes from a secret store, this is the one
 * line that changes and every caller keeps working, because none of them ever
 * held the value.
 *
 * **IT REFUSES RATHER THAN DEFAULTING, AND IT REFUSES WHEN IT IS CALLED.** A
 * key with a default is a store every deployment can open. Refusing at the
 * moment of use rather than at startup is deliberate: a deployment that will
 * never write should not be stopped from reading because a key it does not need
 * is absent.
 */
export function storagePasswordFrom(env: NodeJS.ProcessEnv): () => Promise<string> {
  return async () => {
    const key = env.MIDNIGHT_PRIVATE_STATE_PASSWORD;
    if (!key) {
      throw new Error(
        'this deployment has no key for its private state store, and a write is the only '
        + 'thing that needs the store opened. It is not defaulted: a default here is a store '
        + 'every deployment can open, and what is inside it is the signing material a device '
        + 'proves with.');
    }
    return key;
  };
}

/** Where the compiled artefacts live, relative to a deployment's root. */
export const artifactsIn = (root: string): string => `${root}/contracts/managed`;

/**
 * What this deployment can write with, or nothing.
 *
 * `wallets` is the funded pair, or `null` when none has been handed to this
 * process. **A `null` here is answered with `undefined` and no work at all** -
 * nothing is read off disk, no artefact is loaded, and the boundary above goes
 * on refusing every write by name and saying which pieces are missing.
 *
 * **WHEN A PAIR IS HANDED IN, EVERY OTHER PIECE MUST RESOLVE OR THIS THROWS.**
 * A process that was given a wallet and cannot find its own governance record
 * or its own compiled contract is misconfigured, and the honest outcome is a
 * refusal naming the missing fact rather than a deployment that holds a wallet
 * and quietly cannot use it.
 */
export async function deploymentWriteCapability(
  root: string,
  env: NodeJS.ProcessEnv,
  wallets: FundedParties | null,
): Promise<WriteCapability | undefined> {
  if (!wallets) return undefined;
  return {
    /*
     * Read, never chosen. Whoever holds this can change which proofs the
     * contract accepts, alone and outside the company's own threshold, so it
     * is a decision a person records before a deploy - and a deployment that
     * picked one for itself would be the exact failure the record exists to
     * prevent.
     */
    maintenanceAuthority: loadMaintenanceAuthority(root),
    compiled: await compiledAccountContract(artifactsIn(root)),
    customer: wallets.customer,
    sponsor: wallets.sponsor,
    storagePassword: storagePasswordFrom(env),
  };
}
