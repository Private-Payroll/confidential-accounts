/**
 * The invitee taking the seat an approved invitation names, built the way the
 * invitee's own wallet builds it: their seat key, blinding and rights, the
 * address they were invited at, and the salt the invitation's identity was made
 * with. The circuit runs while the call is built, so a seat the account refuses
 * is refused here, before anything is handed to the chain. What comes back is
 * the unproven call, encoded as a signer's device hands one to the service.
 */
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';
import type { AccountPrivateState, InvitedAddress } from '../src/witnesses.js';
import { invitedAddressFor } from './simulator.js';

export interface InviteeSeat {
  /** The account's compiled contract, with its witnesses. */
  readonly accountCompiled: unknown;
  /** Where the account's proving material is read from. */
  readonly accountZk: unknown;
  /** The company's account address, hex. */
  readonly company: string;
  /** The account's state on the chain now, serialized. */
  readonly accountState: Uint8Array;
  /** The invitee's own device. */
  readonly who: AccountPrivateState;
  /** The invitation's identity and the salt it was made with, hex. */
  readonly proposal: string;
  readonly salt: string;
  /** The address the invitee was invited at; the simulator's for `who` when absent. */
  readonly invite?: InvitedAddress;
  /** Take a slot a removal freed rather than a fresh one. */
  readonly intoVacatedSlot?: boolean;
}

/** The invitee's `seatInvited` call, unproven, base64 - or a refusal from the account's own circuit. */
export async function inviteeSeatCall(i: InviteeSeat): Promise<string> {
  const keys = L.ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(3));
  const built: any = await (contracts as any).createUnprovenCallTxFromInitialStates(i.accountZk, {
    compiledContract: i.accountCompiled,
    circuitId: 'seatInvited',
    contractAddress: i.company,
    coinPublicKey: keys.coinPublicKey,
    initialContractState: (runtime as any).ContractState.deserialize(i.accountState),
    initialZswapChainState: new L.ZswapChainState(),
    ledgerParameters: L.LedgerParameters.initialParameters(),
    initialPrivateState: {
      ...i.who, invite: i.invite ?? invitedAddressFor(i.who), proposalSalt: Buffer.from(i.salt, 'hex'), pinnedPath: null,
    },
    args: [Buffer.from(i.proposal, 'hex'), i.intoVacatedSlot === true],
  }, keys.encryptionPublicKey);
  return Buffer.from(built.private.unprovenTx.serialize()).toString('base64');
}
